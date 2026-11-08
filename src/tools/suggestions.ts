import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';
import { withRetry } from '../utils/retry.js';
import { findTabById, findTextRange, withTab } from './docs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Read the body content the write will be computed against. Google's rule is
// that indexes in a write must come from a read with suggestions inline,
// because existing suggested insertions and deletions occupy indexes.
async function readInlineContent(
  ctx: ToolContext,
  documentId: string,
  tabId?: string,
): Promise<{ content?: any[]; error?: string }> {
  const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
  const params: Record<string, unknown> = {
    documentId,
    suggestionsViewMode: 'SUGGESTIONS_INLINE',
  };
  if (tabId) params.includeTabsContent = true;

  const res = await withRetry(
    (signal) => docs.documents.get(params, { signal }),
    ctx.runtimeConfig,
    'docs.documents.get(suggestions)',
    ctx.log,
  );

  const data = res.data as any;
  if (tabId) {
    const tab = data.tabs ? findTabById(data.tabs, tabId) : null;
    if (!tab) {
      return {
        error: `Tab with ID "${tabId}" not found. Use listDocumentTabs to see available tabs.`,
      };
    }
    return { content: tab.documentTab?.body?.content ?? [] };
  }
  return { content: data.body?.content ?? [] };
}

async function resolveTextRange(
  ctx: ToolContext,
  documentId: string,
  textToFind: string,
  matchInstance: number,
  tabId?: string,
): Promise<{ startIndex: number; endIndex: number; segmentEndIndex?: number } | { error: string }> {
  const read = await readInlineContent(ctx, documentId, tabId);
  if (read.error) return { error: read.error };

  const range = await findTextRange(
    ctx,
    documentId,
    textToFind,
    matchInstance,
    tabId,
    read.content,
  );
  if (range && 'error' in range) return range;
  if (!range) return { error: `Text "${textToFind}" not found in document` };
  return range;
}

interface BatchOutcome {
  data?: any;
  error?: string;
}

async function sendBatch(
  ctx: ToolContext,
  documentId: string,
  requestBody: Record<string, unknown>,
  label: string,
): Promise<BatchOutcome> {
  const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
  try {
    const res = await withRetry(
      (signal) => docs.documents.batchUpdate({ documentId, requestBody }, { signal }),
      { ...ctx.runtimeConfig, retryMax: 0 },
      label,
      ctx.log,
    );
    return { data: res.data };
  } catch (error: any) {
    return { error: error?.message ?? String(error) };
  }
}

// Every request in a SUGGEST batch answers with one suggestionResponses entry.
// A missing entry, or one without created suggestion ids, means that change was
// not suggested even when the batch itself succeeded.
function collectSuggestionIds(
  data: any,
  changeNames: string[],
): { ids?: string[]; error?: string } {
  const responses = data?.suggestionResponses;
  const ids: string[] = [];
  for (let i = 0; i < changeNames.length; i++) {
    const created = Array.isArray(responses) ? responses[i]?.createdSuggestionIds : undefined;
    if (!Array.isArray(created) || created.length === 0) {
      return {
        error: `The document did not create a suggestion for ${changeNames[i]}.`,
      };
    }
    ids.push(...created);
  }
  // A batch can fail in part, and the API answers with one response per
  // request; extra entries mean the operation as a whole did not land cleanly.
  if (!Array.isArray(responses) || responses.length !== changeNames.length) {
    return {
      error: `The document reported a partial suggestion response, so ${changeNames.join(' and ')} was not fully suggested.`,
    };
  }
  return { ids };
}

function suggestionSuccess(ids: string[]): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text:
          `Created suggestion(s) ${ids.join(', ')}. ` +
          'The visible text stays unchanged until the document\'s owner accepts the suggestion.',
      },
    ],
    isError: false,
  };
}

const SUGGEST_DESCRIPTION_TAIL =
  'The visible text stays unchanged until the document\'s owner accepts the suggestion. ' +
  'Prefer textToFind: the tool then reads the document with suggestions inline, while the ' +
  'indexes of an earlier read may differ when the document holds suggestions.';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const SuggestInsertTextSchema = z
  .object({
    documentId: z.string().min(1, 'Document ID is required'),
    text: z.string().min(1, 'Text to insert is required'),
    index: z.number().int().min(1, 'Index must be at least 1').optional(),
    textToFind: z.string().min(1).optional(),
    matchInstance: z.number().int().min(1).optional().default(1),
    position: z.enum(['before', 'after']).optional().default('after'),
    tabId: z.string().optional(),
  })
  .refine((d) => (d.index !== undefined) !== (d.textToFind !== undefined), {
    message: 'Provide exactly one of index or textToFind',
  });

const SuggestDeleteTextSchema = z
  .object({
    documentId: z.string().min(1, 'Document ID is required'),
    startIndex: z.number().int().min(1, 'Start index must be at least 1').optional(),
    endIndex: z.number().int().min(1, 'End index must be at least 1').optional(),
    textToFind: z.string().min(1).optional(),
    matchInstance: z.number().int().min(1).optional().default(1),
    tabId: z.string().optional(),
  })
  .refine(
    (d) => {
      const anyIndex = d.startIndex !== undefined || d.endIndex !== undefined;
      const bothIndices = d.startIndex !== undefined && d.endIndex !== undefined;
      return d.textToFind !== undefined ? !anyIndex : bothIndices;
    },
    { message: 'Provide either startIndex+endIndex or textToFind, not both' },
  )
  .refine(
    (d) => d.startIndex === undefined || d.endIndex === undefined || d.endIndex > d.startIndex,
    { message: 'End index must be greater than start index', path: ['endIndex'] },
  );

const SuggestReplaceTextSchema = z
  .object({
    documentId: z.string().min(1, 'Document ID is required'),
    text: z.string().min(1, 'Replacement text is required'),
    startIndex: z.number().int().min(1, 'Start index must be at least 1').optional(),
    endIndex: z.number().int().min(1, 'End index must be at least 1').optional(),
    textToFind: z.string().min(1).optional(),
    matchInstance: z.number().int().min(1).optional().default(1),
    tabId: z.string().optional(),
  })
  .refine(
    (d) => {
      const anyIndex = d.startIndex !== undefined || d.endIndex !== undefined;
      const bothIndices = d.startIndex !== undefined && d.endIndex !== undefined;
      return d.textToFind !== undefined ? !anyIndex : bothIndices;
    },
    { message: 'Provide either startIndex+endIndex or textToFind, not both' },
  )
  .refine(
    (d) => d.startIndex === undefined || d.endIndex === undefined || d.endIndex > d.startIndex,
    { message: 'End index must be greater than start index', path: ['endIndex'] },
  );

const CommentOnTextSchema = z
  .object({
    documentId: z.string().min(1, 'Document ID is required'),
    commentText: z
      .string()
      .min(1, 'Comment text is required')
      .max(2048, 'Comment text must be at most 2048 characters'),
    startIndex: z.number().int().min(1, 'Start index must be at least 1').optional(),
    endIndex: z.number().int().min(1, 'End index must be at least 1').optional(),
    textToFind: z.string().min(1).optional(),
    matchInstance: z.number().int().min(1).optional().default(1),
    tabId: z.string().optional(),
  })
  .refine(
    (d) => {
      const anyIndex = d.startIndex !== undefined || d.endIndex !== undefined;
      const bothIndices = d.startIndex !== undefined && d.endIndex !== undefined;
      return d.textToFind !== undefined ? !anyIndex : bothIndices;
    },
    { message: 'Provide either startIndex+endIndex or textToFind, not both' },
  )
  .refine(
    (d) => d.startIndex === undefined || d.endIndex === undefined || d.endIndex > d.startIndex,
    { message: 'End index must be greater than start index', path: ['endIndex'] },
  );

const ReplyToDocCommentSchema = z
  .object({
    documentId: z.string().min(1, 'Document ID is required'),
    replyText: z
      .string()
      .min(1, 'Reply text is required')
      .max(2048, 'Reply text must be at most 2048 characters'),
    commentId: z.string().min(1).optional(),
    suggestionId: z.string().min(1).optional(),
  })
  .refine((d) => (d.commentId !== undefined) !== (d.suggestionId !== undefined), {
    message: 'Provide exactly one of commentId or suggestionId',
  });

const ListDocCommentsAndSuggestionsSchema = z.object({
  documentId: z.string().min(1, 'Document ID is required'),
  tabId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'suggestInsertText',
    description:
      'Insert text as a suggestion in a Google Doc. ' + SUGGEST_DESCRIPTION_TAIL,
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'The document ID' },
        text: { type: 'string', description: 'Text to suggest inserting' },
        index: { type: 'number', description: 'Position to insert at (1-based Docs API index). Provide exactly one of index or textToFind.' },
        textToFind: { type: 'string', description: 'Locate the insertion point by exact, case-sensitive text instead of an index. Combine with position and matchInstance.' },
        matchInstance: { type: 'number', description: 'Which instance of textToFind (default: 1)' },
        position: { type: 'string', enum: ['before', 'after'], description: 'Insert before or after the matched text (default: after). Only used with textToFind.' },
        tabId: { type: 'string', description: 'Optional. Tab ID to insert into (from listDocumentTabs).' },
      },
      required: ['documentId', 'text'],
    },
  },
  {
    name: 'suggestDeleteText',
    description:
      'Delete a range as a suggestion in a Google Doc. ' + SUGGEST_DESCRIPTION_TAIL,
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'The document ID' },
        startIndex: { type: 'number', description: 'Start index (inclusive, 1-based Docs API index). Provide startIndex+endIndex or textToFind.' },
        endIndex: { type: 'number', description: 'End index (exclusive).' },
        textToFind: { type: 'string', description: 'Delete the matched text instead of an index range (exact, case-sensitive match). Combine with matchInstance.' },
        matchInstance: { type: 'number', description: 'Which instance of textToFind (default: 1)' },
        tabId: { type: 'string', description: 'Optional. Tab ID to delete from (from listDocumentTabs).' },
      },
      required: ['documentId'],
    },
  },
  {
    name: 'suggestReplaceText',
    description:
      'Replace a range as a suggestion in a Google Doc, by inserting the new text and deleting the old range in one batch. ' +
      SUGGEST_DESCRIPTION_TAIL,
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'The document ID' },
        text: { type: 'string', description: 'Replacement text to suggest' },
        startIndex: { type: 'number', description: 'Start index (inclusive, 1-based Docs API index). Provide startIndex+endIndex or textToFind.' },
        endIndex: { type: 'number', description: 'End index (exclusive).' },
        textToFind: { type: 'string', description: 'Replace the matched text instead of an index range (exact, case-sensitive match). Combine with matchInstance.' },
        matchInstance: { type: 'number', description: 'Which instance of textToFind (default: 1)' },
        tabId: { type: 'string', description: 'Optional. Tab ID to edit (from listDocumentTabs).' },
      },
      required: ['documentId', 'text'],
    },
  },
  {
    name: 'commentOnText',
    description:
      'Create an anchored comment on a text range through the Docs API. The comment records the quoted passage. ' +
      'The tool sets no assignee.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'The document ID' },
        commentText: { type: 'string', description: 'The comment content, at most 2048 characters' },
        startIndex: { type: 'number', description: 'Start index (inclusive, 1-based). Provide startIndex+endIndex or textToFind.' },
        endIndex: { type: 'number', description: 'End index (exclusive).' },
        textToFind: { type: 'string', description: 'Comment on this exact text instead of using indices (case-sensitive).' },
        matchInstance: { type: 'number', description: 'Which occurrence of textToFind to comment on (default: 1)' },
        tabId: { type: 'string', description: 'Optional. Tab ID for multi-tab documents.' },
      },
      required: ['documentId', 'commentText'],
    },
  },
  {
    name: 'replyToDocComment',
    description:
      'Reply to an existing comment or suggestion thread through the Docs API. ' +
      'Provide exactly one of commentId or suggestionId; the reply is added to that thread.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'The document ID' },
        replyText: { type: 'string', description: 'The reply content, at most 2048 characters' },
        commentId: { type: 'string', description: 'The comment thread to reply to. Provide this or suggestionId.' },
        suggestionId: { type: 'string', description: 'The suggestion thread to reply to. Provide this or commentId.' },
      },
      required: ['documentId', 'replyText'],
    },
  },
  {
    name: 'listDocCommentsAndSuggestions',
    description:
      'List every comment thread and suggestion thread in a Google Doc, with each thread\'s id, status, quoted text or summary, and posts. ' +
      'This is a read: it does not create, edit, accept or reject anything.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'The document ID' },
        tabId: { type: 'string', description: 'Optional. Tab ID to scope comment threads to (from listDocumentTabs). Suggestion threads are document-wide and are always listed.' },
      },
      required: ['documentId'],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (toolName) {
    case 'suggestInsertText': {
      const validation = SuggestInsertTextSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      let index: number;
      if (a.textToFind !== undefined) {
        const range = await resolveTextRange(
          ctx,
          a.documentId,
          a.textToFind,
          a.matchInstance,
          a.tabId,
        );
        if ('error' in range) return errorResponse(range.error);
        index = a.position === 'before' ? range.startIndex : range.endIndex;
        // Docs refuses an insert at the segment end, just past the final
        // paragraph break; move it before that break.
        if (range.segmentEndIndex !== undefined && index >= range.segmentEndIndex) {
          index = range.segmentEndIndex - 1;
        }
      } else {
        index = a.index!;
      }

      const requests = [
        {
          insertText: {
            location: withTab({ index }, a.tabId),
            text: a.text,
          },
        },
      ];
      const outcome = await sendBatch(
        ctx,
        a.documentId,
        { requests, writeControl: { writeMode: 'SUGGEST' } },
        'docs.documents.batchUpdate(suggestInsertText)',
      );
      if (outcome.error) return errorResponse(outcome.error);

      const collected = collectSuggestionIds(outcome.data, ['the text insertion']);
      if (collected.error) return errorResponse(collected.error);
      return suggestionSuccess(collected.ids!);
    }

    case 'suggestDeleteText': {
      const validation = SuggestDeleteTextSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      let startIndex: number;
      let endIndex: number;
      if (a.textToFind !== undefined) {
        const range = await resolveTextRange(
          ctx,
          a.documentId,
          a.textToFind,
          a.matchInstance,
          a.tabId,
        );
        if ('error' in range) return errorResponse(range.error);
        startIndex = range.startIndex;
        endIndex = range.endIndex;
        if (range.segmentEndIndex !== undefined && endIndex >= range.segmentEndIndex) {
          endIndex = range.segmentEndIndex - 1;
          if (endIndex <= startIndex) {
            return errorResponse(
              `Text "${a.textToFind}" matches only the document's final paragraph break, which Google Docs does not allow deleting`,
            );
          }
        }
      } else {
        startIndex = a.startIndex!;
        endIndex = a.endIndex!;
      }

      const requests = [
        {
          deleteContentRange: {
            range: withTab({ startIndex, endIndex }, a.tabId),
          },
        },
      ];
      const outcome = await sendBatch(
        ctx,
        a.documentId,
        { requests, writeControl: { writeMode: 'SUGGEST' } },
        'docs.documents.batchUpdate(suggestDeleteText)',
      );
      if (outcome.error) return errorResponse(outcome.error);

      const collected = collectSuggestionIds(outcome.data, ['the text deletion']);
      if (collected.error) return errorResponse(collected.error);
      return suggestionSuccess(collected.ids!);
    }

    case 'suggestReplaceText': {
      const validation = SuggestReplaceTextSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      let startIndex: number;
      let endIndex: number;
      if (a.textToFind !== undefined) {
        const range = await resolveTextRange(
          ctx,
          a.documentId,
          a.textToFind,
          a.matchInstance,
          a.tabId,
        );
        if ('error' in range) return errorResponse(range.error);
        startIndex = range.startIndex;
        endIndex = range.endIndex;
      } else {
        startIndex = a.startIndex!;
        endIndex = a.endIndex!;
      }

      // Insert at endIndex first, then delete the original range. One batch so
      // the two suggestions describe the same replacement.
      const requests = [
        {
          insertText: {
            location: withTab({ index: endIndex }, a.tabId),
            text: a.text,
          },
        },
        {
          deleteContentRange: {
            range: withTab({ startIndex, endIndex }, a.tabId),
          },
        },
      ];
      const outcome = await sendBatch(
        ctx,
        a.documentId,
        { requests, writeControl: { writeMode: 'SUGGEST' } },
        'docs.documents.batchUpdate(suggestReplaceText)',
      );
      if (outcome.error) return errorResponse(outcome.error);

      const collected = collectSuggestionIds(outcome.data, [
        'the text insertion',
        'the text deletion',
      ]);
      if (collected.error) return errorResponse(collected.error);
      return suggestionSuccess(collected.ids!);
    }

    case 'commentOnText': {
      const validation = CommentOnTextSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      let startIndex: number;
      let endIndex: number;
      if (a.textToFind !== undefined) {
        const range = await resolveTextRange(
          ctx,
          a.documentId,
          a.textToFind,
          a.matchInstance,
          a.tabId,
        );
        if ('error' in range) return errorResponse(range.error);
        startIndex = range.startIndex;
        endIndex = range.endIndex;
      } else {
        startIndex = a.startIndex!;
        endIndex = a.endIndex!;
      }

      const requests = [
        {
          insertComment: {
            content: a.commentText,
            range: withTab({ startIndex, endIndex }, a.tabId),
          },
        },
      ];
      const outcome = await sendBatch(
        ctx,
        a.documentId,
        { requests },
        'docs.documents.batchUpdate(commentOnText)',
      );
      if (outcome.error) return errorResponse(outcome.error);

      if (outcome.data?.commentUpdateState !== 'ALL_SAVED') {
        return errorResponse(
          `The document did not save the comment (state: ${outcome.data?.commentUpdateState ?? 'missing'}).`,
        );
      }
      const thread = outcome.data?.replies?.[0]?.insertComment?.commentThread;
      const commentId = thread?.commentId;
      if (!commentId) {
        return errorResponse('The document saved the comment but did not report its comment id.');
      }
      const quote = thread?.plainTextQuote ?? '';
      return {
        content: [
          {
            type: 'text',
            text: `Comment ${commentId} created${quote ? ` quoting "${quote}"` : ''}.`,
          },
        ],
        isError: false,
      };
    }

    case 'replyToDocComment': {
      const validation = ReplyToDocCommentSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      const target =
        a.commentId !== undefined ? { commentId: a.commentId } : { suggestionId: a.suggestionId };
      const requests = [
        {
          addCommentReply: {
            ...target,
            post: { content: a.replyText },
          },
        },
      ];
      const outcome = await sendBatch(
        ctx,
        a.documentId,
        { requests },
        'docs.documents.batchUpdate(replyToDocComment)',
      );
      if (outcome.error) return errorResponse(outcome.error);

      if (outcome.data?.commentUpdateState !== 'ALL_SAVED') {
        return errorResponse(
          `The document did not save the reply (state: ${outcome.data?.commentUpdateState ?? 'missing'}).`,
        );
      }
      const postId = outcome.data?.replies?.[0]?.addCommentReply?.post?.postId;
      if (!postId) {
        return errorResponse('The document saved the reply but did not report its post id.');
      }
      return {
        content: [{ type: 'text', text: `Reply ${postId} added to the thread.` }],
        isError: false,
      };
    }

    case 'listDocCommentsAndSuggestions': {
      const validation = ListDocCommentsAndSuggestionsSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      const docs = ctx.google.docs({ version: 'v1', auth: ctx.authClient });
      const params: Record<string, unknown> = {
        documentId: a.documentId,
        commentsViewMode: 'COMMENTS_VIEW_MODE_INCLUDED',
        suggestionsViewMode: 'SUGGESTIONS_INLINE',
      };
      if (a.tabId) params.includeTabsContent = true;

      const res = await withRetry(
        (signal) => docs.documents.get(params, { signal }),
        ctx.runtimeConfig,
        'docs.documents.get(listDocCommentsAndSuggestions)',
        ctx.log,
      );
      const data = res.data as any;

      const tab = a.tabId ? (data.tabs ? findTabById(data.tabs, a.tabId) : null) : null;
      if (a.tabId && !tab) {
        return errorResponse(
          `Tab with ID "${a.tabId}" not found. Use listDocumentTabs to see available tabs.`,
        );
      }

      // Comments are document-level, but a thread's anchorId names a
      // CommentAnchor. Each tab lists its own anchors, so with tabId only the
      // threads anchored in that tab are in scope. Suggestions carry no tab.
      const allComments = Array.isArray(data.comments) ? data.comments : [];
      const anchors = tab?.documentTab?.commentAnchors;
      const comments = a.tabId
        ? allComments.filter(
            (comment: any) =>
              comment?.anchorId !== undefined &&
              anchors !== undefined &&
              Object.prototype.hasOwnProperty.call(anchors, comment.anchorId),
          )
        : allComments;
      const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];

      const lines: string[] = [];

      if (comments.length > 0) {
        lines.push(a.tabId ? `Comments in tab ${a.tabId}:` : 'Comments:');
        for (const comment of comments) {
          lines.push(
            `- Comment ${comment.commentId ?? 'unknown'} [${comment.status ?? 'unknown'}]`,
          );
          if (comment.plainTextQuote) lines.push(`  Quoted: ${comment.plainTextQuote}`);
          const posts = [comment.headPost, ...(comment.replies ?? [])].filter(Boolean);
          for (const post of posts) {
            const author = post.author?.displayName ?? 'Unknown author';
            lines.push(`  ${author}: ${post.content ?? ''}`);
          }
        }
      } else if (a.tabId) {
        lines.push(`No comments are anchored in tab ${a.tabId}.`);
      }

      if (suggestions.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(a.tabId ? 'Suggestions (whole document):' : 'Suggestions:');
        for (const suggestion of suggestions) {
          lines.push(
            `- Suggestion ${suggestion.suggestionId ?? 'unknown'} [${suggestion.status ?? 'unknown'}]: ${suggestion.summaryText ?? ''}`,
          );
        }
      }

      if (lines.length === 0) {
        return {
          content: [{ type: 'text', text: 'No comments or suggestions found.' }],
          isError: false,
        };
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
      };
    }

    default:
      return null;
  }
}
