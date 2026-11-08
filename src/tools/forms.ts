import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import { errorResponse } from '../types.js';
import { withRetry } from '../utils/retry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const QUESTION_TYPES = [
  'SHORT_ANSWER',
  'PARAGRAPH',
  'MULTIPLE_CHOICE',
  'CHECKBOXES',
  'DROPDOWN',
  'SCALE',
  'DATE',
  'TIME',
] as const;

const CHOICE_TYPES = new Set(['MULTIPLE_CHOICE', 'CHECKBOXES', 'DROPDOWN']);

function formsService(ctx: ToolContext): any {
  return ctx.google.forms({ version: 'v1', auth: ctx.authClient });
}

async function readForm(ctx: ToolContext, formId: string): Promise<any> {
  const forms = formsService(ctx);
  const res = (await withRetry(
    (signal) => forms.forms.get({ formId }, { signal }),
    ctx.runtimeConfig,
    'forms.get',
    ctx.log,
  )) as any;
  return res.data as any;
}

interface BatchOutcome {
  data?: any;
  error?: string;
}

function httpStatus(error: any): number | undefined {
  const status = error?.response?.status ?? error?.status ?? error?.code;
  return typeof status === 'number' ? status : undefined;
}

async function sendBatch(
  ctx: ToolContext,
  formId: string,
  requestBody: Record<string, unknown>,
  label: string,
  revisionLocked: boolean,
): Promise<BatchOutcome> {
  const forms = formsService(ctx);
  try {
    const res = (await withRetry(
      (signal) => forms.forms.batchUpdate({ formId, requestBody }, { signal }),
      { ...ctx.runtimeConfig, retryMax: 0 },
      label,
      ctx.log,
    )) as any;
    return { data: res.data };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    if (revisionLocked && httpStatus(error) === 400) {
      return {
        error:
          `${message}. The form may have changed since it was read, so read it again ` +
          'with getForm and retry.',
      };
    }
    return { error: message };
  }
}

function writeControl(form: any): Record<string, unknown> | undefined {
  return form?.revisionId ? { requiredRevisionId: form.revisionId } : undefined;
}

function buildQuestion(
  type: (typeof QUESTION_TYPES)[number],
  a: z.infer<typeof AddFormQuestionSchema>,
): { question?: any; error?: string } {
  const required = a.required;

  if (a.options && !CHOICE_TYPES.has(type)) {
    return { error: 'options are only valid for multiple-choice, checkbox, or dropdown questions' };
  }

  switch (type) {
    case 'SHORT_ANSWER':
      return { question: { required, textQuestion: { paragraph: false } } };
    case 'PARAGRAPH':
      return { question: { required, textQuestion: { paragraph: true } } };
    case 'MULTIPLE_CHOICE':
    case 'CHECKBOXES':
    case 'DROPDOWN': {
      const options = a.options ?? [];
      if (options.length === 0) {
        return { error: `${type} requires at least one option` };
      }
      if (new Set(options).size !== options.length) {
        return { error: 'options must be unique' };
      }
      const choiceType =
        type === 'MULTIPLE_CHOICE' ? 'RADIO' : type === 'CHECKBOXES' ? 'CHECKBOX' : 'DROP_DOWN';
      return {
        question: {
          required,
          choiceQuestion: {
            type: choiceType,
            options: options.map((value) => ({ value })),
          },
        },
      };
    }
    case 'SCALE': {
      if (a.low === undefined || a.high === undefined) {
        return { error: 'SCALE requires both low and high' };
      }
      if (a.low >= a.high) {
        return { error: 'SCALE requires low to be less than high' };
      }
      const scaleQuestion: any = { low: a.low, high: a.high };
      if (a.lowLabel !== undefined) scaleQuestion.lowLabel = a.lowLabel;
      if (a.highLabel !== undefined) scaleQuestion.highLabel = a.highLabel;
      return { question: { required, scaleQuestion } };
    }
    case 'DATE':
      return {
        question: {
          required,
          dateQuestion: {
            includeTime: a.includeTime ?? false,
            includeYear: a.includeYear ?? false,
          },
        },
      };
    case 'TIME':
      return {
        question: {
          required,
          timeQuestion: { duration: a.duration ?? false },
        },
      };
    default:
      return { error: 'Unsupported question type' };
  }
}

function describeQuestion(question: any): string {
  if (question.textQuestion) {
    return question.textQuestion.paragraph ? 'paragraph' : 'short answer';
  }
  if (question.choiceQuestion) {
    const type = question.choiceQuestion.type;
    if (type === 'CHECKBOX') return 'checkbox';
    if (type === 'DROP_DOWN') return 'dropdown';
    if (type === 'RADIO') return 'multiple choice (radio)';
    return 'multiple choice';
  }
  if (question.scaleQuestion) return 'scale';
  if (question.dateQuestion) return 'date';
  if (question.timeQuestion) return 'time';
  if (question.fileUploadQuestion) return 'file upload';
  if (question.ratingQuestion) return 'rating';
  if (question.rowQuestion) return 'row question';
  return 'question';
}

function describeItem(item: any): string {
  if (item.questionItem?.question) return describeQuestion(item.questionItem.question);
  if (item.questionGroupItem) return 'question group (grid)';
  if (item.pageBreakItem) return 'page break';
  if (item.textItem) return 'text item';
  if (item.imageItem) return 'image';
  if (item.videoItem) return 'video';
  return 'item';
}

function formatItem(item: any, index: number): string {
  const parts: string[] = [`${index}.`, `itemId=${item.itemId ?? ''}`];
  if (item.title !== undefined) parts.push(`title="${item.title}"`);
  parts.push(`kind=${describeItem(item)}`);

  const question = item.questionItem?.question;
  if (question) {
    if (question.questionId) parts.push(`questionId=${question.questionId}`);
    parts.push(`required=${question.required ? 'true' : 'false'}`);
    const options = question.choiceQuestion?.options;
    if (Array.isArray(options) && options.length > 0) {
      parts.push(`options=[${options.map((option: any) => option.value).join(', ')}]`);
    }
    const scale = question.scaleQuestion;
    if (scale) {
      parts.push(`scale=${scale.low ?? '?'}..${scale.high ?? '?'}`);
      if (scale.lowLabel) parts.push(`lowLabel="${scale.lowLabel}"`);
      if (scale.highLabel) parts.push(`highLabel="${scale.highLabel}"`);
    }
    const date = question.dateQuestion;
    if (date) {
      parts.push(`includeTime=${date.includeTime ? 'true' : 'false'}`);
      parts.push(`includeYear=${date.includeYear ? 'true' : 'false'}`);
    }
    const time = question.timeQuestion;
    if (time) parts.push(`duration=${time.duration ? 'true' : 'false'}`);
  }

  const group = item.questionGroupItem;
  if (group) {
    const questions = Array.isArray(group.questions) ? group.questions : [];
    const ids = questions.map((groupQuestion: any) => groupQuestion.questionId).filter(Boolean);
    if (ids.length > 0) parts.push(`questionIds=[${ids.join(', ')}]`);
    const options = group.grid?.columns?.options;
    if (Array.isArray(options) && options.length > 0) {
      parts.push(`options=[${options.map((option: any) => option.value).join(', ')}]`);
    }
  }

  return `  ${parts.join(' ')}`;
}

function formatForm(form: any): string {
  const info = form.info ?? {};
  const publish = form.publishSettings?.publishState ?? {};
  const items = Array.isArray(form.items) ? form.items : [];
  const lines: string[] = [`Title: ${info.title ?? ''}`];
  if (info.description !== undefined) lines.push(`Description: ${info.description}`);
  lines.push(`Form ID: ${form.formId ?? ''}`);
  lines.push(`Revision: ${form.revisionId ?? ''}`);
  lines.push(`Responder URI: ${form.responderUri ?? ''}`);
  lines.push(`Published: ${publish.isPublished ? 'true' : 'false'}`);
  lines.push(`Accepting responses: ${publish.isAcceptingResponses ? 'true' : 'false'}`);
  lines.push(`Items (${items.length}):`);
  for (const [index, item] of items.entries()) lines.push(formatItem(item, index));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateFormSchema = z.object({
  title: z.string().min(1, 'Form title is required'),
  documentTitle: z.string().optional(),
  description: z.string().optional(),
});

const GetFormSchema = z.object({
  formId: z.string().min(1, 'Form ID is required'),
});

const AddFormQuestionSchema = z.object({
  formId: z.string().min(1, 'Form ID is required'),
  title: z.string().min(1, 'Question title is required'),
  questionType: z.enum(QUESTION_TYPES),
  required: z.boolean().optional().default(false),
  description: z.string().optional(),
  options: z.array(z.string().min(1, 'Option must not be empty')).optional(),
  index: z.number().int().min(0, 'Index must be at least 0').optional(),
  low: z.number().int().optional(),
  high: z.number().int().optional(),
  lowLabel: z.string().optional(),
  highLabel: z.string().optional(),
  includeTime: z.boolean().optional(),
  includeYear: z.boolean().optional(),
  duration: z.boolean().optional(),
});

const UpdateFormQuestionSchema = z.object({
  formId: z.string().min(1, 'Form ID is required'),
  formItemId: z.string().min(1, 'Form item ID is required'),
  title: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1, 'Option must not be empty')).optional(),
});

const DeleteFormQuestionSchema = z.object({
  formId: z.string().min(1, 'Form ID is required'),
  formItemId: z.string().min(1, 'Form item ID is required'),
});

const ListFormResponsesSchema = z.object({
  formId: z.string().min(1, 'Form ID is required'),
  pageSize: z.number().int().min(1).optional(),
  pageToken: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'createForm',
    description:
      'Create a Google Form. Google creates it published and accepting responses as soon as it ' +
      'exists. Optionally set the document title and a description.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Form title' },
        documentTitle: { type: 'string', description: 'Title of the linked Google Drive document (optional)' },
        description: { type: 'string', description: 'Form description, written after creation (optional)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'getForm',
    description:
      'Read a Google Form: its title, description, responder link, publish state, and every item ' +
      'in order with its position, item ID, kind, question ID, options, and whether it is ' +
      'required. This is a read: it changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        formId: { type: 'string', description: 'Form ID' },
      },
      required: ['formId'],
    },
  },
  {
    name: 'addFormQuestion',
    description:
      'Add a question to a Google Form. questionType is one of SHORT_ANSWER, PARAGRAPH, ' +
      'MULTIPLE_CHOICE, CHECKBOXES, DROPDOWN, SCALE, DATE, or TIME. Choice questions take ' +
      'options; SCALE takes low and high; DATE takes includeTime and includeYear; TIME takes ' +
      'duration. The form is read first and the write is refused if it changed in between.',
    inputSchema: {
      type: 'object',
      properties: {
        formId: { type: 'string', description: 'Form ID' },
        title: { type: 'string', description: 'Question title' },
        questionType: {
          type: 'string',
          enum: [...QUESTION_TYPES],
          description: 'Question kind',
        },
        required: { type: 'boolean', description: 'Whether the question must be answered (default false)' },
        description: { type: 'string', description: 'Question description (optional)' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Choices for MULTIPLE_CHOICE, CHECKBOXES, or DROPDOWN (required for those kinds; rejected on other kinds)',
        },
        index: { type: 'number', description: 'Position to insert at, from 0 to the item count (optional, default appends)' },
        low: { type: 'number', description: 'Lowest value for SCALE (required for that kind)' },
        high: { type: 'number', description: 'Highest value for SCALE (required for that kind)' },
        lowLabel: { type: 'string', description: 'Label for the low end of a SCALE (optional)' },
        highLabel: { type: 'string', description: 'Label for the high end of a SCALE (optional)' },
        includeTime: { type: 'boolean', description: 'Whether a DATE question includes the time (optional)' },
        includeYear: { type: 'boolean', description: 'Whether a DATE question includes the year (optional)' },
        duration: { type: 'boolean', description: 'For TIME only: true for an elapsed time, otherwise a time of day' },
      },
      required: ['formId', 'title', 'questionType'],
    },
  },
  {
    name: 'updateFormQuestion',
    description:
      'Update a question in a Google Form by its formItemId: title, description, required, or ' +
      'the options of a choice question. The item is found by reading the form first, and the ' +
      'write is refused if the form changed in between.',
    inputSchema: {
      type: 'object',
      properties: {
        formId: { type: 'string', description: 'Form ID' },
        formItemId: { type: 'string', description: 'Item ID from getForm' },
        title: { type: 'string', description: 'New title (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
        required: { type: 'boolean', description: 'New required flag, for a question (optional)' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'New choices for a choice question (optional)',
        },
      },
      required: ['formId', 'formItemId'],
    },
  },
  {
    name: 'deleteFormQuestion',
    description:
      'Delete a question from a Google Form by its formItemId. The item is found by reading the ' +
      'form first, and the write is refused if the form changed in between.',
    inputSchema: {
      type: 'object',
      properties: {
        formId: { type: 'string', description: 'Form ID' },
        formItemId: { type: 'string', description: 'Item ID from getForm' },
      },
      required: ['formId', 'formItemId'],
    },
  },
  {
    name: 'listFormResponses',
    description:
      'List the responses to a Google Form under their question titles, with each response ID, ' +
      'submission time, respondent email, and answers. Pass pageToken to page through results.',
    inputSchema: {
      type: 'object',
      properties: {
        formId: { type: 'string', description: 'Form ID' },
        pageSize: { type: 'number', description: 'Maximum responses to return (optional)' },
        pageToken: { type: 'string', description: 'Token for the next page, from a previous response (optional)' },
      },
      required: ['formId'],
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
    case 'createForm': {
      const validation = CreateFormSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      const info: any = { title: a.title };
      if (a.documentTitle !== undefined) info.documentTitle = a.documentTitle;

      const forms = formsService(ctx);
      const createdRes = (await withRetry(
        (signal) => forms.forms.create({ requestBody: { info } }, { signal }),
        { ...ctx.runtimeConfig, retryMax: 0 },
        'forms.create',
        ctx.log,
      )) as any;
      const created = createdRes.data as any;

      if (a.description !== undefined) {
        const outcome = await sendBatch(
          ctx,
          created.formId,
          {
            requests: [
              {
                updateFormInfo: {
                  info: { description: a.description },
                  updateMask: 'description',
                },
              },
            ],
          },
          'forms.batchUpdate(createForm)',
          false,
        );
        if (outcome.error) return errorResponse(outcome.error);
      }

      const publish = created.publishSettings?.publishState ?? {};
      const lines = [
        `Created form "${created.info?.title ?? a.title}".`,
        `Form ID: ${created.formId}`,
        `Responder URI: ${created.responderUri}`,
        `Edit URL: https://docs.google.com/forms/d/${created.formId}/edit`,
        `Published: ${publish.isPublished ? 'true' : 'false'}`,
        `Accepting responses: ${publish.isAcceptingResponses ? 'true' : 'false'}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
    }

    case 'getForm': {
      const validation = GetFormSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      const form = await readForm(ctx, a.formId);
      return { content: [{ type: 'text', text: formatForm(form) }], isError: false };
    }

    case 'addFormQuestion': {
      const validation = AddFormQuestionSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      const built = buildQuestion(a.questionType, a);
      if (built.error) return errorResponse(built.error);

      const form = await readForm(ctx, a.formId);
      const items = Array.isArray(form.items) ? form.items : [];
      const index = a.index ?? items.length;
      if (index > items.length) {
        return errorResponse(
          `Index ${index} is past the end of the form; it has ${items.length} items, so the largest insert position is ${items.length}.`,
        );
      }

      const item: any = { title: a.title };
      if (a.description !== undefined) item.description = a.description;
      item.questionItem = { question: built.question };

      const requestBody: any = {
        requests: [
          {
            createItem: {
              item,
              location: { index },
            },
          },
        ],
      };
      const control = writeControl(form);
      if (control) requestBody.writeControl = control;

      const outcome = await sendBatch(
        ctx,
        a.formId,
        requestBody,
        'forms.batchUpdate(addFormQuestion)',
        !!control,
      );
      if (outcome.error) return errorResponse(outcome.error);

      const created = outcome.data?.replies?.[0]?.createItem;
      const questionIds = Array.isArray(created?.questionId) ? created.questionId : [];
      return {
        content: [
          {
            type: 'text',
            text:
              `Added ${a.questionType} question "${a.title}" at position ${index}. ` +
              `itemId=${created?.itemId ?? 'unknown'}` +
              (questionIds.length > 0 ? ` questionId=${questionIds.join(', ')}` : ''),
          },
        ],
        isError: false,
      };
    }

    case 'updateFormQuestion': {
      const validation = UpdateFormQuestionSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      if (
        a.title === undefined &&
        a.description === undefined &&
        a.required === undefined &&
        a.options === undefined
      ) {
        return errorResponse(
          'Provide at least one of title, description, required, or options to update.',
        );
      }

      const form = await readForm(ctx, a.formId);
      const items = Array.isArray(form.items) ? form.items : [];
      const index = items.findIndex((item: any) => item.itemId === a.formItemId);
      if (index < 0) {
        return errorResponse(
          `Item ${a.formItemId} not found in form ${a.formId}. Use getForm to see the item IDs.`,
        );
      }

      const updated = JSON.parse(JSON.stringify(items[index]));
      const mask: string[] = [];

      if (a.title !== undefined) {
        updated.title = a.title;
        mask.push('title');
      }
      if (a.description !== undefined) {
        updated.description = a.description;
        mask.push('description');
      }
      if (a.required !== undefined) {
        if (!updated.questionItem?.question) {
          return errorResponse('Only a question item has a required flag.');
        }
        updated.questionItem.question.required = a.required;
        mask.push('questionItem.question.required');
      }
      if (a.options !== undefined) {
        if (!updated.questionItem?.question?.choiceQuestion) {
          return errorResponse(
            'options can only be set on a multiple-choice, checkbox, or dropdown question.',
          );
        }
        if (a.options.length === 0) {
          return errorResponse('options must not be empty.');
        }
        if (new Set(a.options).size !== a.options.length) {
          return errorResponse('options must be unique.');
        }
        updated.questionItem.question.choiceQuestion.options = a.options.map((value) => ({
          value,
        }));
        mask.push('questionItem.question.choiceQuestion.options');
      }

      const requestBody: any = {
        requests: [
          {
            updateItem: {
              location: { index },
              updateMask: mask.join(','),
              item: updated,
            },
          },
        ],
      };
      const control = writeControl(form);
      if (control) requestBody.writeControl = control;

      const outcome = await sendBatch(
        ctx,
        a.formId,
        requestBody,
        'forms.batchUpdate(updateFormQuestion)',
        !!control,
      );
      if (outcome.error) return errorResponse(outcome.error);

      return {
        content: [
          {
            type: 'text',
            text: `Updated item ${a.formItemId} at position ${index}: ${mask.join(', ')}.`,
          },
        ],
        isError: false,
      };
    }

    case 'deleteFormQuestion': {
      const validation = DeleteFormQuestionSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      const form = await readForm(ctx, a.formId);
      const items = Array.isArray(form.items) ? form.items : [];
      const index = items.findIndex((item: any) => item.itemId === a.formItemId);
      if (index < 0) {
        return errorResponse(
          `Item ${a.formItemId} not found in form ${a.formId}. Use getForm to see the item IDs.`,
        );
      }

      const requestBody: any = {
        requests: [{ deleteItem: { location: { index } } }],
      };
      const control = writeControl(form);
      if (control) requestBody.writeControl = control;

      const outcome = await sendBatch(
        ctx,
        a.formId,
        requestBody,
        'forms.batchUpdate(deleteFormQuestion)',
        !!control,
      );
      if (outcome.error) return errorResponse(outcome.error);

      return {
        content: [{ type: 'text', text: `Deleted item ${a.formItemId} at position ${index}.` }],
        isError: false,
      };
    }

    case 'listFormResponses': {
      const validation = ListFormResponsesSchema.safeParse(args);
      if (!validation.success) {
        return errorResponse(validation.error.issues[0].message);
      }
      const a = validation.data;

      const form = await readForm(ctx, a.formId);
      const items = Array.isArray(form.items) ? form.items : [];
      const titles = new Map<string, string>();
      for (const item of items) {
        const question = item.questionItem?.question;
        if (question?.questionId) {
          titles.set(question.questionId, item.title ?? 'Untitled question');
        }
        const groupQuestions = item.questionGroupItem?.questions;
        if (Array.isArray(groupQuestions)) {
          for (const groupQuestion of groupQuestions) {
            if (groupQuestion?.questionId) {
              titles.set(
                groupQuestion.questionId,
                groupQuestion.rowQuestion?.title ?? item.title ?? 'Untitled question',
              );
            }
          }
        }
      }

      const params: any = { formId: a.formId };
      if (a.pageSize !== undefined) params.pageSize = a.pageSize;
      if (a.pageToken !== undefined) params.pageToken = a.pageToken;

      const forms = formsService(ctx);
      const res = (await withRetry(
        (signal) => forms.forms.responses.list(params, { signal }),
        ctx.runtimeConfig,
        'forms.responses.list',
        ctx.log,
      )) as any;
      const data = res.data as any;
      const responses = Array.isArray(data?.responses) ? data.responses : [];

      const lines: string[] = [];
      if (responses.length === 0) {
        lines.push('No responses found.');
      } else {
        lines.push(`Responses: ${responses.length}`);
        for (const response of responses) {
          const respondent = response.respondentEmail
            ? ` respondent=${response.respondentEmail}`
            : '';
          lines.push(
            `- responseId=${response.responseId ?? 'unknown'} submitted=${response.lastSubmittedTime ?? 'unknown'}${respondent}`,
          );
          const answers = response.answers ?? {};
          for (const [questionId, answer] of Object.entries(answers)) {
            const title = titles.get(questionId) ?? 'Unknown question';
            const values = (answer as any)?.textAnswers?.answers;
            const text = Array.isArray(values)
              ? values
                  .map((entry: any) => entry.value)
                  .filter((value: any) => value !== undefined && value !== null)
                  .join(', ')
              : '';
            lines.push(`  ${title}: ${text}`);
          }
        }
      }
      if (data?.nextPageToken) lines.push(`Next page token: ${data.nextPageToken}`);

      return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
    }

    default:
      return null;
  }
}
