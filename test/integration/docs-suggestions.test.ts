import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

// Recorded Google Docs answers used by these tests. The fixtures live in
// test/fixtures and are copied into .tmp-test/test/fixtures by test:build, so
// resolve them relative to this compiled test file.
function fixture(name: string): any {
  const url = new URL(`../fixtures/docs-suggestions/${name}`, import.meta.url);
  return JSON.parse(fs.readFileSync(url, 'utf8'));
}

function googleError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status, code: status });
}

const SUGGESTION_ONE = 'suggest.k3bq9x1';
const SUGGESTION_TWO = 'suggest.m7tw2p4';
const COMMENT_ID = 'AAAB2cX9f3kQm5';
const COMMENT_POST_ID = 'post.9d1c2';
const REPLY_POST_ID = 'post.4f8a1';

const SUGGESTION_TOOLS = ['suggestInsertText', 'suggestDeleteText', 'suggestReplaceText'] as const;
const NEW_TOOLS = [
  ...SUGGESTION_TOOLS,
  'commentOnText',
  'replyToDocComment',
  'listDocCommentsAndSuggestions',
] as const;

describe('Docs suggestions and Docs API comments', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });

  function resetFakes() {
    ctx.mocks.docs.tracker.reset();
    ctx.mocks.drive.tracker.reset();
    ctx.mocks.docs.service.documents.get._resetImpl();
    ctx.mocks.docs.service.documents.batchUpdate._resetImpl();
    ctx.mocks.drive.service.comments.create._resetImpl();
    ctx.mocks.drive.service.replies.create._resetImpl();
  }

  beforeEach(resetFakes);
  afterEach(resetFakes);

  function batchCalls() {
    return ctx.mocks.docs.tracker.getCalls('documents.batchUpdate');
  }

  function getCalls() {
    return ctx.mocks.docs.tracker.getCalls('documents.get');
  }

  function installDoc(doc: any) {
    ctx.mocks.docs.service.documents.get._setImpl(async () => ({ data: doc }));
  }

  // The suggestion tools must force writeControl.writeMode = SUGGEST. This fake
  // behaves like the Docs API and refuses any other write mode with a
  // Google-shaped 400.
  function installSuggestionBatch(response: any) {
    ctx.mocks.docs.service.documents.batchUpdate._setImpl(async (params: any) => {
      const writeMode = params?.requestBody?.writeControl?.writeMode;
      if (writeMode !== 'SUGGEST') {
        throw googleError('Invalid requests[0]: write control must be SUGGEST');
      }
      return { data: response };
    });
  }

  // Comment tools are not suggestion writes; the Docs API accepts their
  // requests without a writeMode. Do not impose SUGGEST on them.
  function installCommentBatch(response: any) {
    ctx.mocks.docs.service.documents.batchUpdate._setImpl(async () => ({ data: response }));
  }

  function installRefusingBatch() {
    ctx.mocks.docs.service.documents.batchUpdate._setImpl(async () => {
      throw googleError('Invalid requests[0]: bad index');
    });
  }

  // The real API answers 400 when commentsViewMode is requested without an
  // inline-suggestions read. Mirror that so a tool that omits
  // suggestionsViewMode cannot accidentally pass against the mock.
  function installThreadsDoc() {
    const doc = fixture('doc-comments-and-suggestions.json');
    ctx.mocks.docs.service.documents.get._setImpl(async (params: any) => {
      if (
        params?.commentsViewMode === 'COMMENTS_VIEW_MODE_INCLUDED' &&
        params?.suggestionsViewMode !== 'SUGGESTIONS_INLINE'
      ) {
        throw googleError('commentsViewMode requires suggestionsViewMode SUGGESTIONS_INLINE');
      }
      return { data: doc };
    });
    return doc;
  }

  function assertSuggestionSuccess(res: any, ids: string[]) {
    const text = res.content?.[0]?.text ?? '';
    assert.equal(res.isError, false, text);
    for (const id of ids) {
      assert.ok(text.includes(id), `answer names created suggestion ${id}: ${text}`);
    }
    assert.match(text, /visible text/i);
    assert.match(text, /unchanged/i);
    assert.match(text, /accept/i);
  }

  function assertSuggestBatch(expectedRequests: any[]) {
    const calls = batchCalls();
    assert.equal(calls.length, 1, 'exactly one batchUpdate');
    const body = calls[0]!.args[0].requestBody;
    assert.equal(body.writeControl?.writeMode, 'SUGGEST');
    assert.deepEqual(body.requests, expectedRequests);
  }

  function assertToolIsRegistered(res: any) {
    const text = res.content?.[0]?.text ?? '';
    assert.ok(!/tool not found/i.test(text), `tool must exist: ${text}`);
  }

  function assertNoSuccessWord(res: any) {
    const text = res.content?.[0]?.text ?? '';
    assertToolIsRegistered(res);
    assert.equal(res.isError, true, text);
    assert.ok(!/successfully/i.test(text), `failure answer must not claim success: ${text}`);
  }

  function assertDocGetsAreInline() {
    for (const call of getCalls()) {
      assert.equal(
        call.args[0]?.suggestionsViewMode,
        'SUGGESTIONS_INLINE',
        'every documents.get must read suggestions inline so indexes match the write',
      );
    }
  }

  function assertAllDocGetsSuggestInline() {
    assert.ok(getCalls().length > 0, 'expected at least one documents.get');
    assertDocGetsAreInline();
  }

  function assertOnlySuggestBatches() {
    for (const call of batchCalls()) {
      assert.equal(
        call.args[0]?.requestBody?.writeControl?.writeMode,
        'SUGGEST',
        'no batch may use a write mode other than SUGGEST',
      );
    }
  }

  // -------------------------------------------------------------------------
  // suggestInsertText
  // -------------------------------------------------------------------------
  describe('suggestInsertText', () => {
    it('inserts at an index in one SUGGEST batch', async () => {
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const res = await callTool(ctx.client, 'suggestInsertText', {
        documentId: 'doc-suggestions',
        text: 'Hello',
        index: 5,
      });

      assertSuggestionSuccess(res, [SUGGESTION_ONE]);
      assertSuggestBatch([{ insertText: { location: { index: 5 }, text: 'Hello' } }]);
      assertDocGetsAreInline();
    });

    it('threads tabId into the insert location', async () => {
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const res = await callTool(ctx.client, 'suggestInsertText', {
        documentId: 'doc-suggestions',
        text: 'Hello',
        index: 5,
        tabId: 'tab-1',
      });

      assertSuggestionSuccess(res, [SUGGESTION_ONE]);
      assertSuggestBatch([
        { insertText: { location: { index: 5, tabId: 'tab-1' }, text: 'Hello' } },
      ]);
      assertDocGetsAreInline();
    });

    it('resolves textToFind against a SUGGESTIONS_INLINE read, inserting after by default', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const res = await callTool(ctx.client, 'suggestInsertText', {
        documentId: 'doc-suggestions',
        text: 'Hello',
        textToFind: 'Budget',
      });

      assertSuggestionSuccess(res, [SUGGESTION_ONE]);
      // "Budget" occupies [1, 7); inserting after it lands at 7.
      assertSuggestBatch([{ insertText: { location: { index: 7 }, text: 'Hello' } }]);
      assertAllDocGetsSuggestInline();
    });

    it('inserts before the match when position is before', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const res = await callTool(ctx.client, 'suggestInsertText', {
        documentId: 'doc-suggestions',
        text: 'Hello',
        textToFind: 'Budget',
        position: 'before',
      });

      assertSuggestionSuccess(res, [SUGGESTION_ONE]);
      assertSuggestBatch([{ insertText: { location: { index: 1 }, text: 'Hello' } }]);
      assertAllDocGetsSuggestInline();
    });

    it('honours matchInstance, including matches inside a suggested insertion', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const res = await callTool(ctx.client, 'suggestInsertText', {
        documentId: 'doc-suggestions',
        text: 'Hello',
        textToFind: 'o',
        matchInstance: 2,
      });

      assertSuggestionSuccess(res, [SUGGESTION_ONE]);
      // The second "o" is in "euro" at index 31; inserting after lands at 32.
      assertSuggestBatch([{ insertText: { location: { index: 32 }, text: 'Hello' } }]);
      assertAllDocGetsSuggestInline();
    });

    it('forces SUGGEST even when the caller passes writeMode EDIT', async () => {
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const res = await callTool(ctx.client, 'suggestInsertText', {
        documentId: 'doc-suggestions',
        text: 'Hello',
        index: 5,
        writeMode: 'EDIT',
      });

      assertToolIsRegistered(res);
      // Either the unknown argument is refused (no batch) or the tool still
      // sends SUGGEST. A batch in EDIT would fail this assertion.
      assert.ok(batchCalls().length <= 1);
      assertOnlySuggestBatches();
    });

    it('reports failure when suggestionResponses is missing', async () => {
      installSuggestionBatch({
        documentId: 'doc-suggestions',
        replies: [],
        commentUpdateState: 'NO_UPDATES_REQUESTED',
      });

      const res = await callTool(ctx.client, 'suggestInsertText', {
        documentId: 'doc-suggestions',
        text: 'Hello',
        index: 5,
      });

      assertNoSuccessWord(res);
    });

    it('reports failure when createdSuggestionIds is empty', async () => {
      installSuggestionBatch({
        documentId: 'doc-suggestions',
        replies: [],
        suggestionResponses: [{ createdSuggestionIds: [] }],
        commentUpdateState: 'NO_UPDATES_REQUESTED',
      });

      const res = await callTool(ctx.client, 'suggestInsertText', {
        documentId: 'doc-suggestions',
        text: 'Hello',
        index: 5,
      });

      assertNoSuccessWord(res);
    });

    it('reports failure when the batch is refused', async () => {
      installRefusingBatch();

      const res = await callTool(ctx.client, 'suggestInsertText', {
        documentId: 'doc-suggestions',
        text: 'Hello',
        index: 5,
      });

      assertNoSuccessWord(res);
    });

    it('refuses missing targets, conflicting targets, empty text, and absent textToFind before any batch', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const invalid = [
        { documentId: 'doc-suggestions', text: 'Hello' },
        { documentId: 'doc-suggestions', text: 'Hello', index: 1, textToFind: 'Budget' },
        { documentId: 'doc-suggestions', text: '', index: 1 },
        { documentId: 'doc-suggestions', text: 'Hello', textToFind: 'not in this document' },
      ];

      for (const args of invalid) {
        const res = await callTool(ctx.client, 'suggestInsertText', args);
        assertToolIsRegistered(res);
        assert.equal(res.isError, true, `expected refusal for ${JSON.stringify(args)}`);
      }
      assert.equal(batchCalls().length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // suggestDeleteText
  // -------------------------------------------------------------------------
  describe('suggestDeleteText', () => {
    it('deletes an index range in one SUGGEST batch', async () => {
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const res = await callTool(ctx.client, 'suggestDeleteText', {
        documentId: 'doc-suggestions',
        startIndex: 14,
        endIndex: 20,
      });

      assertSuggestionSuccess(res, [SUGGESTION_ONE]);
      assertSuggestBatch([
        { deleteContentRange: { range: { startIndex: 14, endIndex: 20 } } },
      ]);
      assertDocGetsAreInline();
    });

    it('threads tabId into the delete range', async () => {
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const res = await callTool(ctx.client, 'suggestDeleteText', {
        documentId: 'doc-suggestions',
        startIndex: 14,
        endIndex: 20,
        tabId: 'tab-1',
      });

      assertSuggestionSuccess(res, [SUGGESTION_ONE]);
      assertSuggestBatch([
        { deleteContentRange: { range: { startIndex: 14, endIndex: 20, tabId: 'tab-1' } } },
      ]);
      assertDocGetsAreInline();
    });

    it('resolves textToFind against a SUGGESTIONS_INLINE read', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const res = await callTool(ctx.client, 'suggestDeleteText', {
        documentId: 'doc-suggestions',
        textToFind: '1200',
      });

      assertSuggestionSuccess(res, [SUGGESTION_ONE]);
      // The existing suggested insertion "1200" occupies [23, 27).
      assertSuggestBatch([
        { deleteContentRange: { range: { startIndex: 23, endIndex: 27 } } },
      ]);
      assertAllDocGetsSuggestInline();
    });

    it('forces SUGGEST even when the caller passes writeMode EDIT', async () => {
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const res = await callTool(ctx.client, 'suggestDeleteText', {
        documentId: 'doc-suggestions',
        startIndex: 14,
        endIndex: 20,
        writeMode: 'EDIT',
      });

      assertToolIsRegistered(res);
      assert.ok(batchCalls().length <= 1);
      assertOnlySuggestBatches();
    });

    it('reports failure with the partial-failure fixture', async () => {
      installSuggestionBatch(fixture('batch-partial-failure.json'));

      const res = await callTool(ctx.client, 'suggestDeleteText', {
        documentId: 'doc-suggestions',
        startIndex: 14,
        endIndex: 20,
      });

      assertNoSuccessWord(res);
    });

    it('reports failure when suggestionResponses is missing', async () => {
      installSuggestionBatch({
        documentId: 'doc-suggestions',
        replies: [],
        commentUpdateState: 'NO_UPDATES_REQUESTED',
      });

      const res = await callTool(ctx.client, 'suggestDeleteText', {
        documentId: 'doc-suggestions',
        startIndex: 14,
        endIndex: 20,
      });

      assertNoSuccessWord(res);
    });

    it('reports failure when the batch is refused', async () => {
      installRefusingBatch();

      const res = await callTool(ctx.client, 'suggestDeleteText', {
        documentId: 'doc-suggestions',
        startIndex: 14,
        endIndex: 20,
      });

      assertNoSuccessWord(res);
    });

    it('refuses missing targets, conflicting targets, inverted ranges, and absent textToFind before any batch', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installSuggestionBatch(fixture('batch-one-suggestion.json'));

      const invalid = [
        { documentId: 'doc-suggestions' },
        { documentId: 'doc-suggestions', startIndex: 14, endIndex: 20, textToFind: '1200' },
        { documentId: 'doc-suggestions', startIndex: 20, endIndex: 14 },
        { documentId: 'doc-suggestions', startIndex: 20, endIndex: 20 },
        { documentId: 'doc-suggestions', textToFind: 'not in this document' },
      ];

      for (const args of invalid) {
        const res = await callTool(ctx.client, 'suggestDeleteText', args);
        assertToolIsRegistered(res);
        assert.equal(res.isError, true, `expected refusal for ${JSON.stringify(args)}`);
      }
      assert.equal(batchCalls().length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // suggestReplaceText
  // -------------------------------------------------------------------------
  describe('suggestReplaceText', () => {
    it('inserts at endIndex then deletes the range in one SUGGEST batch', async () => {
      installSuggestionBatch(fixture('batch-two-suggestions.json'));

      const res = await callTool(ctx.client, 'suggestReplaceText', {
        documentId: 'doc-suggestions',
        text: '1200',
        startIndex: 14,
        endIndex: 20,
      });

      assertSuggestionSuccess(res, [SUGGESTION_ONE, SUGGESTION_TWO]);
      assertSuggestBatch([
        { insertText: { location: { index: 20 }, text: '1200' } },
        { deleteContentRange: { range: { startIndex: 14, endIndex: 20 } } },
      ]);
      assertDocGetsAreInline();
    });

    it('threads tabId into both requests', async () => {
      installSuggestionBatch(fixture('batch-two-suggestions.json'));

      const res = await callTool(ctx.client, 'suggestReplaceText', {
        documentId: 'doc-suggestions',
        text: '1200',
        startIndex: 14,
        endIndex: 20,
        tabId: 'tab-1',
      });

      assertSuggestionSuccess(res, [SUGGESTION_ONE, SUGGESTION_TWO]);
      assertSuggestBatch([
        { insertText: { location: { index: 20, tabId: 'tab-1' }, text: '1200' } },
        { deleteContentRange: { range: { startIndex: 14, endIndex: 20, tabId: 'tab-1' } } },
      ]);
      assertDocGetsAreInline();
    });

    it('resolves textToFind against a SUGGESTIONS_INLINE read', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installSuggestionBatch(fixture('batch-two-suggestions.json'));

      const res = await callTool(ctx.client, 'suggestReplaceText', {
        documentId: 'doc-suggestions',
        text: 'totale',
        textToFind: 'totale',
      });

      assertSuggestionSuccess(res, [SUGGESTION_ONE, SUGGESTION_TWO]);
      // "totale" occupies [14, 20); insert at its end, then delete the original.
      assertSuggestBatch([
        { insertText: { location: { index: 20 }, text: 'totale' } },
        { deleteContentRange: { range: { startIndex: 14, endIndex: 20 } } },
      ]);
      assertAllDocGetsSuggestInline();
    });

    it('forces SUGGEST even when the caller passes writeMode EDIT', async () => {
      installSuggestionBatch(fixture('batch-two-suggestions.json'));

      const res = await callTool(ctx.client, 'suggestReplaceText', {
        documentId: 'doc-suggestions',
        text: 'x',
        startIndex: 14,
        endIndex: 20,
        writeMode: 'EDIT',
      });

      assertToolIsRegistered(res);
      assert.ok(batchCalls().length <= 1);
      assertOnlySuggestBatches();
    });

    it('reports failure with the partial-failure fixture', async () => {
      installSuggestionBatch(fixture('batch-partial-failure.json'));

      const res = await callTool(ctx.client, 'suggestReplaceText', {
        documentId: 'doc-suggestions',
        text: '1200',
        startIndex: 14,
        endIndex: 20,
      });

      assertNoSuccessWord(res);
    });

    it('reports failure when suggestionResponses is missing', async () => {
      installSuggestionBatch({
        documentId: 'doc-suggestions',
        replies: [],
        commentUpdateState: 'NO_UPDATES_REQUESTED',
      });

      const res = await callTool(ctx.client, 'suggestReplaceText', {
        documentId: 'doc-suggestions',
        text: '1200',
        startIndex: 14,
        endIndex: 20,
      });

      assertNoSuccessWord(res);
    });

    it('reports failure when the batch is refused', async () => {
      installRefusingBatch();

      const res = await callTool(ctx.client, 'suggestReplaceText', {
        documentId: 'doc-suggestions',
        text: '1200',
        startIndex: 14,
        endIndex: 20,
      });

      assertNoSuccessWord(res);
    });

    it('refuses missing targets, conflicting targets, inverted ranges, empty text, and absent textToFind before any batch', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installSuggestionBatch(fixture('batch-two-suggestions.json'));

      const invalid = [
        { documentId: 'doc-suggestions', text: '1200' },
        { documentId: 'doc-suggestions', text: '1200', startIndex: 14, endIndex: 20, textToFind: 'totale' },
        { documentId: 'doc-suggestions', text: '1200', startIndex: 20, endIndex: 14 },
        { documentId: 'doc-suggestions', text: '1200', startIndex: 20, endIndex: 20 },
        { documentId: 'doc-suggestions', text: '', startIndex: 14, endIndex: 20 },
        { documentId: 'doc-suggestions', text: '1200', textToFind: 'not in this document' },
      ];

      for (const args of invalid) {
        const res = await callTool(ctx.client, 'suggestReplaceText', args);
        assertToolIsRegistered(res);
        assert.equal(res.isError, true, `expected refusal for ${JSON.stringify(args)}`);
      }
      assert.equal(batchCalls().length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // commentOnText
  // -------------------------------------------------------------------------
  describe('commentOnText', () => {
    it('creates an anchored Docs comment through batchUpdate, not Drive comments.create', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installCommentBatch(fixture('batch-insert-comment-saved.json'));

      const res = await callTool(ctx.client, 'commentOnText', {
        documentId: 'doc-suggestions',
        commentText: 'Why this budget?',
        startIndex: 1,
        endIndex: 11,
        tabId: 'tab-1',
      });

      const text = res.content?.[0]?.text ?? '';
      assert.equal(res.isError, false, text);
      assert.ok(text.includes(COMMENT_ID), `answer names the new comment id: ${text}`);
      assert.ok(text.includes('Budget Q3'), `answer names the quoted text: ${text}`);

      const calls = batchCalls();
      assert.equal(calls.length, 1);
      const body = calls[0]!.args[0].requestBody;
      assert.deepEqual(body.requests, [
        {
          insertComment: {
            content: 'Why this budget?',
            range: { startIndex: 1, endIndex: 11, tabId: 'tab-1' },
          },
        },
      ]);
      assert.equal('assigneeEmailAddress' in body.requests[0].insertComment, false);
      assert.equal(ctx.mocks.drive.tracker.getCalls('comments.create').length, 0);
    });

    it('resolves textToFind to an index range before inserting the comment', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installCommentBatch(fixture('batch-insert-comment-saved.json'));

      const res = await callTool(ctx.client, 'commentOnText', {
        documentId: 'doc-suggestions',
        commentText: 'Is this total right?',
        textToFind: '1200',
      });

      const text = res.content?.[0]?.text ?? '';
      assert.equal(res.isError, false, text);
      assert.ok(text.includes(COMMENT_ID));

      const calls = batchCalls();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.args[0].requestBody.requests, [
        {
          insertComment: {
            content: 'Is this total right?',
            range: { startIndex: 23, endIndex: 27 },
          },
        },
      ]);
      assert.equal(ctx.mocks.drive.tracker.getCalls('comments.create').length, 0);
    });

    it('reports failure when commentUpdateState is ALL_FAILED_UNKNOWN_REASON', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installCommentBatch(fixture('batch-insert-comment-failed.json'));

      const res = await callTool(ctx.client, 'commentOnText', {
        documentId: 'doc-suggestions',
        commentText: 'Why this budget?',
        startIndex: 1,
        endIndex: 11,
      });

      assertNoSuccessWord(res);
      assert.equal(ctx.mocks.drive.tracker.getCalls('comments.create').length, 0);
    });

    it('refuses a commentText over 2048 characters before any batch', async () => {
      installDoc(fixture('doc-suggestions-inline.json'));
      installCommentBatch(fixture('batch-insert-comment-saved.json'));

      const res = await callTool(ctx.client, 'commentOnText', {
        documentId: 'doc-suggestions',
        commentText: 'x'.repeat(2049),
        startIndex: 1,
        endIndex: 11,
      });

      assertToolIsRegistered(res);
      assert.equal(res.isError, true);
      assert.equal(batchCalls().length, 0);
      assert.equal(ctx.mocks.drive.tracker.getCalls('comments.create').length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // replyToDocComment
  // -------------------------------------------------------------------------
  describe('replyToDocComment', () => {
    it('replies to a comment thread through batchUpdate, not Drive replies.create', async () => {
      installCommentBatch(fixture('batch-add-reply-saved.json'));

      const res = await callTool(ctx.client, 'replyToDocComment', {
        documentId: 'doc-suggestions',
        replyText: 'Thanks, will check.',
        commentId: COMMENT_ID,
      });

      const text = res.content?.[0]?.text ?? '';
      assert.equal(res.isError, false, text);
      assert.ok(text.includes(REPLY_POST_ID), `answer names the new post id: ${text}`);

      const calls = batchCalls();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.args[0].requestBody.requests, [
        {
          addCommentReply: {
            commentId: COMMENT_ID,
            post: { content: 'Thanks, will check.' },
          },
        },
      ]);
      assert.equal(ctx.mocks.drive.tracker.getCalls('replies.create').length, 0);
    });

    it('replies to a suggestion thread when suggestionId is given', async () => {
      installCommentBatch(fixture('batch-add-reply-saved.json'));

      const res = await callTool(ctx.client, 'replyToDocComment', {
        documentId: 'doc-suggestions',
        replyText: 'Thanks, will check.',
        suggestionId: SUGGESTION_ONE,
      });

      const text = res.content?.[0]?.text ?? '';
      assert.equal(res.isError, false, text);
      assert.ok(text.includes(REPLY_POST_ID));

      const calls = batchCalls();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.args[0].requestBody.requests, [
        {
          addCommentReply: {
            suggestionId: SUGGESTION_ONE,
            post: { content: 'Thanks, will check.' },
          },
        },
      ]);
      assert.equal(ctx.mocks.drive.tracker.getCalls('replies.create').length, 0);
    });

    it('refuses both or neither of commentId and suggestionId before any batch', async () => {
      installCommentBatch(fixture('batch-add-reply-saved.json'));

      const invalid = [
        { documentId: 'doc-suggestions', replyText: 'Thanks', commentId: COMMENT_ID, suggestionId: SUGGESTION_ONE },
        { documentId: 'doc-suggestions', replyText: 'Thanks' },
      ];

      for (const args of invalid) {
        const res = await callTool(ctx.client, 'replyToDocComment', args);
        assertToolIsRegistered(res);
        assert.equal(res.isError, true, `expected refusal for ${JSON.stringify(args)}`);
      }
      assert.equal(batchCalls().length, 0);
    });

    it('reports failure when commentUpdateState is not ALL_SAVED', async () => {
      installCommentBatch(fixture('batch-insert-comment-failed.json'));

      const res = await callTool(ctx.client, 'replyToDocComment', {
        documentId: 'doc-suggestions',
        replyText: 'Thanks, will check.',
        commentId: COMMENT_ID,
      });

      assertNoSuccessWord(res);
      assert.equal(ctx.mocks.drive.tracker.getCalls('replies.create').length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // listDocCommentsAndSuggestions
  // -------------------------------------------------------------------------
  describe('listDocCommentsAndSuggestions', () => {
    it('reads comments and suggestions with the right view modes and sends no batch', async () => {
      installThreadsDoc();

      const res = await callTool(ctx.client, 'listDocCommentsAndSuggestions', {
        documentId: 'doc-suggestions',
      });

      const text = res.content?.[0]?.text ?? '';
      assert.equal(res.isError, false, text);
      for (const expected of [
        COMMENT_ID,
        'OPEN',
        'Budget Q3',
        'Reviewer One',
        'Why is Q3 lower than Q2?',
        'Author Two',
        'Because the launch slipped.',
        SUGGESTION_ONE,
        'Insert',
        '1200',
      ]) {
        assert.ok(text.includes(expected), `answer names ${JSON.stringify(expected)}: ${text}`);
      }

      assert.equal(batchCalls().length, 0);
      const reads = getCalls();
      assert.ok(reads.length >= 1, 'expected a documents.get');
      const commentReads = reads.filter(
        (read) => read.args[0]?.commentsViewMode === 'COMMENTS_VIEW_MODE_INCLUDED',
      );
      assert.ok(commentReads.length >= 1, 'expected a read that asks for comments');
      for (const read of commentReads) {
        assert.equal(read.args[0]?.suggestionsViewMode, 'SUGGESTIONS_INLINE');
      }
    });

    it('lists only comment threads anchored in the requested tab, plus every suggestion', async () => {
      installDoc(fixture('doc-comments-two-tabs.json'));

      const res = await callTool(ctx.client, 'listDocCommentsAndSuggestions', {
        documentId: 'doc-suggestions',
        tabId: 'tab-2',
      });

      const text = res.content?.[0]?.text ?? '';
      assert.equal(res.isError, false, text);
      assert.ok(text.includes('comment.tab.two'), `answer names the second tab's comment: ${text}`);
      assert.ok(!text.includes('comment.tab.one'), `answer omits the first tab's comment: ${text}`);
      for (const id of [SUGGESTION_ONE, SUGGESTION_TWO]) {
        assert.ok(text.includes(id), `answer names suggestion ${id}: ${text}`);
      }
      assert.match(text, /whole document/i);

      const reads = getCalls();
      assert.equal(reads.length, 1);
      assert.equal(reads[0]!.args[0]?.includeTabsContent, true);
      assert.equal(reads[0]!.args[0]?.commentsViewMode, 'COMMENTS_VIEW_MODE_INCLUDED');
      assert.equal(reads[0]!.args[0]?.suggestionsViewMode, 'SUGGESTIONS_INLINE');
    });
  });

  // -------------------------------------------------------------------------
  // Tool surface
  // -------------------------------------------------------------------------
  describe('tool surface', () => {
    it('registers the six tools with the documented arguments', async () => {
      const { tools } = await ctx.client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool as any]));

      for (const name of NEW_TOOLS) {
        assert.ok(byName.has(name), `missing tool: ${name}`);
      }

      for (const name of SUGGESTION_TOOLS) {
        const props = byName.get(name)!.inputSchema.properties ?? {};
        assert.equal('writeMode' in props, false, `${name} must not advertise writeMode`);
        assert.equal('writeControl' in props, false, `${name} must not advertise writeControl`);
      }

      const commentProps = byName.get('commentOnText')!.inputSchema.properties ?? {};
      assert.equal('assigneeEmailAddress' in commentProps, false, 'commentOnText must not accept an assignee');

      const replyProps = byName.get('replyToDocComment')!.inputSchema.properties ?? {};
      assert.ok(replyProps.commentId, 'replyToDocComment advertises commentId');
      assert.ok(replyProps.suggestionId, 'replyToDocComment advertises suggestionId');

      const listProps = byName.get('listDocCommentsAndSuggestions')!.inputSchema.properties ?? {};
      assert.ok(listProps.tabId, 'listDocCommentsAndSuggestions advertises tabId');

      assert.equal(
        byName.get('listDocCommentsAndSuggestions')!.annotations?.readOnlyHint,
        true,
        'the threads read is read-only',
      );
      for (const name of NEW_TOOLS) {
        if (name === 'listDocCommentsAndSuggestions') continue;
        assert.notEqual(
          byName.get(name)!.annotations?.readOnlyHint,
          true,
          `${name} must not claim to be read-only`,
        );
      }
    });
  });
});
