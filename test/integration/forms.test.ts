import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { setupTestServer, callTool, type TestContext } from '../helpers/setup-server.js';

// Recorded Google Forms answers used by these tests. The fixtures live in
// test/fixtures and are copied into .tmp-test/test/fixtures by test:build, so
// resolve them relative to this compiled test file.
function fixture(name: string): any {
  const url = new URL(`../fixtures/forms/${name}`, import.meta.url);
  return JSON.parse(fs.readFileSync(url, 'utf8'));
}

function googleError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status, code: status });
}

function textOf(res: any): string {
  return res?.content?.[0]?.text ?? '';
}

function sectionAround(text: string, needle: string): string {
  const index = text.indexOf(needle);
  if (index < 0) return '';
  return text.slice(Math.max(0, index - 300), index + needle.length + 300);
}

const FORM_ID = '1FAIpQLSdIscrizioneCorso2026';
const REVISION_ID = '0000004a';
const NAME_ITEM_ID = '2a1b3c4d';
const NAME_QUESTION_ID = '4f8a1c2d';
const PAGE_BREAK_ITEM_ID = '5e6f7a8b';
const TURNO_ITEM_ID = '9c0d1e2f';
const TURNO_QUESTION_ID = '7b3e9d10';
const NOTE_ITEM_ID = '3a4b5c6d';
const NOTE_QUESTION_ID = '9c2a4e6f';

const NEW_TOOLS = [
  'createForm',
  'getForm',
  'addFormQuestion',
  'updateFormQuestion',
  'deleteFormQuestion',
  'listFormResponses',
] as const;

describe('Google Forms tools', () => {
  let ctx: TestContext;

  before(async () => { ctx = await setupTestServer(); });
  after(async () => { await ctx.cleanup(); });

  function resetFakes() {
    ctx.mocks.forms.tracker.reset();
    const forms = ctx.mocks.forms.service.forms;
    forms.create._resetImpl();
    forms.get._resetImpl();
    forms.batchUpdate._resetImpl();
    forms.responses.list._resetImpl();
  }

  beforeEach(resetFakes);
  afterEach(resetFakes);

  function createCalls() {
    return ctx.mocks.forms.tracker.getCalls('forms.create');
  }
  function formCalls() {
    return ctx.mocks.forms.tracker.getCalls('forms.get');
  }
  function batchCalls() {
    return ctx.mocks.forms.tracker.getCalls('forms.batchUpdate');
  }
  function responseCalls() {
    return ctx.mocks.forms.tracker.getCalls('forms.responses.list');
  }

  function installForm(form: any = fixture('form-iscrizione.json')) {
    ctx.mocks.forms.service.forms.get._setImpl(async () => ({ data: form }));
    return form;
  }

  function installCreate(form: any = fixture('form-create.json')) {
    ctx.mocks.forms.service.forms.create._setImpl(async () => ({ data: form }));
    return form;
  }

  function installBatch(name: string) {
    const data = fixture(name);
    ctx.mocks.forms.service.forms.batchUpdate._setImpl(async () => ({ data }));
    return data;
  }

  function installResponses(data: any = fixture('responses-list.json')) {
    ctx.mocks.forms.service.forms.responses.list._setImpl(async () => ({ data }));
    return data;
  }

  function assertOk(res: any) {
    assert.equal(res.isError, false, textOf(res));
    return textOf(res);
  }

  function assertToolIsRegistered(res: any) {
    assert.ok(!/tool not found/i.test(textOf(res)), `tool must exist: ${textOf(res)}`);
  }

  // -------------------------------------------------------------------------
  // createForm
  // -------------------------------------------------------------------------
  describe('createForm', () => {
    it('creates with only the title when no documentTitle is given', async () => {
      const created = installCreate();

      const res = await callTool(ctx.client, 'createForm', { title: 'Modulo base' });
      const text = assertOk(res);

      const calls = createCalls();
      assert.equal(calls.length, 1, 'one forms.create');
      assert.deepEqual(calls[0]!.args[0].requestBody.info, { title: 'Modulo base' });
      assert.equal(batchCalls().length, 0, 'no batch without a description');

      assert.ok(text.includes(created.formId), text);
      assert.ok(text.includes(created.responderUri), text);
      assert.ok(text.includes(`https://docs.google.com/forms/d/${created.formId}/edit`), text);
    });

    it('copies documentTitle and sends the description in one updateFormInfo batch', async () => {
      const created = installCreate();
      installBatch('batch-update-form-info.json');

      const res = await callTool(ctx.client, 'createForm', {
        title: 'Modulo base',
        documentTitle: 'Modulo base (documento)',
        description: 'Compila tutti i campi richiesti.',
      });
      const text = assertOk(res);

      const create = createCalls()[0]!.args[0];
      assert.deepEqual(create.requestBody.info, {
        title: 'Modulo base',
        documentTitle: 'Modulo base (documento)',
      });

      const batches = batchCalls();
      assert.equal(batches.length, 1, 'one batch for the description');
      assert.deepEqual(batches[0]!.args[0].requestBody.requests, [
        {
          updateFormInfo: {
            info: { description: 'Compila tutti i campi richiesti.' },
            updateMask: 'description',
          },
        },
      ]);

      assert.ok(text.includes(created.formId), text);
      assert.ok(text.includes(created.responderUri), text);
      assert.ok(text.includes(`https://docs.google.com/forms/d/${created.formId}/edit`), text);
    });
  });

  // -------------------------------------------------------------------------
  // getForm
  // -------------------------------------------------------------------------
  describe('getForm', () => {
    it('answers metadata and every item in order without writing', async () => {
      const form = installForm();

      const res = await callTool(ctx.client, 'getForm', { formId: FORM_ID });
      const text = assertOk(res);

      for (const expected of [form.info.title, form.info.description, form.responderUri]) {
        assert.ok(text.includes(expected), `answer names ${expected}: ${text}`);
      }
      assert.match(text, /published[^\n]*(true|yes)/i);
      assert.match(text, /accept[^\n]*(true|yes)/i);

      const ids = form.items.map((item: any) => item.itemId);
      const positions = ids.map((id: string) => text.indexOf(id));
      assert.ok(positions.every((position: number) => position >= 0), `all itemIds are named: ${text}`);
      assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'items keep their order');

      for (const [index, item] of form.items.entries()) {
        const section = sectionAround(text, item.itemId);
        assert.ok(section.includes(item.title), `item ${item.itemId} names its title: ${section}`);
        assert.ok(
          new RegExp(`(?:position|index)\\s*[:#]?\\s*${index}\\b`, 'i').test(section) ||
            new RegExp(`\\b${index}\\s*[.):]`).test(section),
          `item ${item.itemId} is shown at position ${index}: ${section}`,
        );
      }

      const nameSection = sectionAround(text, NAME_ITEM_ID);
      assert.match(nameSection, /short answer|short_answer|shortanswer|text question/i);
      assert.match(nameSection, /required[^\n]*(true|yes)/i);
      assert.ok(nameSection.includes(NAME_QUESTION_ID), nameSection);

      const pageSection = sectionAround(text, PAGE_BREAK_ITEM_ID);
      assert.match(pageSection, /page break|page_break|pagebreak/i);

      const turnoSection = sectionAround(text, TURNO_ITEM_ID);
      assert.match(turnoSection, /multiple choice|multiple_choice|multiplechoice|radio/i);
      assert.ok(turnoSection.includes('Mattina'), turnoSection);
      assert.ok(turnoSection.includes('Pomeriggio'), turnoSection);
      assert.ok(turnoSection.includes(TURNO_QUESTION_ID), turnoSection);
      assert.match(turnoSection, /required[^\n]*(false|no)/i);

      const noteSection = sectionAround(text, NOTE_ITEM_ID);
      assert.match(noteSection, /paragraph/i);
      assert.ok(noteSection.includes(NOTE_QUESTION_ID), noteSection);
      assert.match(noteSection, /required[^\n]*(false|no)/i);

      assert.equal(batchCalls().length, 0, 'getForm sends no batch');
    });

    it('names every question kind and non-question kind', async () => {
      const kindForm = {
        formId: FORM_ID,
        info: { title: 'Tipi di domanda', description: '', documentTitle: 'Tipi di domanda' },
        revisionId: REVISION_ID,
        responderUri: 'https://docs.google.com/forms/d/e/1FAIpQLSdIscrizioneCorso2026/viewform',
        publishSettings: { publishState: { isPublished: false, isAcceptingResponses: false } },
        items: [
          {
            itemId: 'k1a2b3c4',
            title: 'Testo breve',
            questionItem: {
              question: { questionId: 'q1a2b3c4', required: false, textQuestion: { paragraph: false } },
            },
          },
          {
            itemId: 'k2a3b4c5',
            title: 'Testo lungo',
            questionItem: {
              question: { questionId: 'q2a3b4c5', required: false, textQuestion: { paragraph: true } },
            },
          },
          {
            itemId: 'k3a4b5c6',
            title: 'Scelta singola',
            questionItem: {
              question: {
                questionId: 'q3a4b5c6',
                required: false,
                choiceQuestion: { type: 'RADIO', options: [{ value: 'A' }] },
              },
            },
          },
          {
            itemId: 'k4a5b6c7',
            title: 'Caselle',
            questionItem: {
              question: {
                questionId: 'q4a5b6c7',
                required: false,
                choiceQuestion: { type: 'CHECKBOX', options: [{ value: 'B' }] },
              },
            },
          },
          {
            itemId: 'k5a6b7c8',
            title: 'Menu a tendina',
            questionItem: {
              question: {
                questionId: 'q5a6b7c8',
                required: false,
                choiceQuestion: { type: 'DROP_DOWN', options: [{ value: 'C' }] },
              },
            },
          },
          {
            itemId: 'k6a7b8c9',
            title: 'Scala',
            questionItem: {
              question: {
                questionId: 'q6a7b8c9',
                required: false,
                scaleQuestion: { low: 1, high: 5 },
              },
            },
          },
          {
            itemId: 'k7a8b9c0',
            title: 'Data',
            questionItem: {
              question: {
                questionId: 'q7a8b9c0',
                required: false,
                dateQuestion: { includeTime: false, includeYear: true },
              },
            },
          },
          {
            itemId: 'k8a9b0c1',
            title: 'Ora',
            questionItem: {
              question: {
                questionId: 'q8a9b0c1',
                required: false,
                timeQuestion: { duration: false },
              },
            },
          },
          { itemId: 'k9a0b1c2', title: 'Interruzione', pageBreakItem: {} },
          { itemId: 'k0a1b2c3', title: 'Testo statico', textItem: {} },
          {
            itemId: 'k1b2c3d4',
            title: 'Immagine',
            imageItem: { image: { sourceUri: 'https://example.com/picture.png' } },
          },
          {
            itemId: 'k2c3d4e5',
            title: 'Filmato',
            videoItem: { video: { youtubeUri: 'https://youtu.be/example' } },
          },
          {
            itemId: 'k3d4e5f6',
            title: 'Griglia',
            questionGroupItem: {
              questions: [
                {
                  questionId: 'q3d4e5f6',
                  required: false,
                  rowQuestion: { title: 'Riga' },
                },
              ],
              grid: {
                columns: { type: 'RADIO', options: [{ value: 'Sì' }] },
              },
            },
          },
        ],
      };
      installForm(kindForm);

      const res = await callTool(ctx.client, 'getForm', { formId: FORM_ID });
      const text = assertOk(res);

      const kinds: Array<[string, string, RegExp]> = [
        ['k1a2b3c4', 'Testo breve', /short answer|short_answer|shortanswer|text question/i],
        ['k2a3b4c5', 'Testo lungo', /paragraph/i],
        ['k3a4b5c6', 'Scelta singola', /multiple choice|multiple_choice|multiplechoice|radio/i],
        ['k4a5b6c7', 'Caselle', /checkbox/i],
        ['k5a6b7c8', 'Menu a tendina', /drop.?down/i],
        ['k6a7b8c9', 'Scala', /scale/i],
        ['k7a8b9c0', 'Data', /date/i],
        ['k8a9b0c1', 'Ora', /time/i],
        ['k9a0b1c2', 'Interruzione', /page break|page_break|pagebreak/i],
        ['k0a1b2c3', 'Testo statico', /text item|text_item|textitem|static text/i],
        ['k1b2c3d4', 'Immagine', /image/i],
        ['k2c3d4e5', 'Filmato', /video/i],
        ['k3d4e5f6', 'Griglia', /question group|question_group|questiongroup|grid/i],
      ];

      for (const [itemId, title, kind] of kinds) {
        const section = sectionAround(text, itemId);
        assert.ok(section.includes(title), `item ${itemId} names its title: ${section}`);
        assert.match(section, kind, `item ${itemId} names its kind: ${section}`);
      }
      assert.ok(text.includes('q3d4e5f6'), 'a question group names its questionId');
      assert.equal(batchCalls().length, 0, 'getForm sends no batch');
    });
  });

  // -------------------------------------------------------------------------
  // addFormQuestion
  // -------------------------------------------------------------------------
  describe('addFormQuestion', () => {
    const cases = [
      {
        questionType: 'SHORT_ANSWER',
        extra: {},
        question: { required: true, textQuestion: { paragraph: false } },
      },
      {
        questionType: 'PARAGRAPH',
        extra: {},
        question: { required: true, textQuestion: { paragraph: true } },
      },
      {
        questionType: 'MULTIPLE_CHOICE',
        extra: { options: ['Mattina', 'Pomeriggio'] },
        question: {
          required: true,
          choiceQuestion: {
            type: 'RADIO',
            options: [{ value: 'Mattina' }, { value: 'Pomeriggio' }],
          },
        },
      },
      {
        questionType: 'CHECKBOXES',
        extra: { options: ['Italiano', 'Inglese'] },
        question: {
          required: true,
          choiceQuestion: {
            type: 'CHECKBOX',
            options: [{ value: 'Italiano' }, { value: 'Inglese' }],
          },
        },
      },
      {
        questionType: 'DROPDOWN',
        extra: { options: ['Sì', 'No'] },
        question: {
          required: true,
          choiceQuestion: {
            type: 'DROP_DOWN',
            options: [{ value: 'Sì' }, { value: 'No' }],
          },
        },
      },
      {
        questionType: 'SCALE',
        extra: { low: 1, high: 5, lowLabel: 'Per niente', highLabel: 'Molto' },
        question: {
          required: true,
          scaleQuestion: { low: 1, high: 5, lowLabel: 'Per niente', highLabel: 'Molto' },
        },
      },
      {
        questionType: 'DATE',
        extra: { includeTime: true, includeYear: false },
        question: { required: true, dateQuestion: { includeTime: true, includeYear: false } },
      },
      {
        questionType: 'TIME',
        extra: { duration: true },
        question: { required: true, timeQuestion: { duration: true } },
      },
    ];

    for (const testCase of cases) {
      it(`maps ${testCase.questionType} to the matching question kind`, async () => {
        installForm();
        const created = installBatch('batch-create-item.json');
        const title = `Domanda ${testCase.questionType}`;
        const description = `Descrizione ${testCase.questionType}`;

        const res = await callTool(ctx.client, 'addFormQuestion', {
          formId: FORM_ID,
          title,
          questionType: testCase.questionType,
          required: true,
          description,
          ...testCase.extra,
        });
        const text = assertOk(res);

        assert.equal(formCalls().length, 1, 'reads the form first');
        assert.equal(formCalls()[0]!.args[0].formId, FORM_ID);
        const batches = batchCalls();
        assert.equal(batches.length, 1, 'exactly one batch');
        const body = batches[0]!.args[0].requestBody;
        assert.deepEqual(body.writeControl, { requiredRevisionId: REVISION_ID });
        assert.deepEqual(body.requests, [
          {
            createItem: {
              item: {
                title,
                description,
                questionItem: { question: testCase.question },
              },
              location: { index: 4 },
            },
          },
        ]);

        const createdItem = created.replies[0].createItem;
        assert.ok(text.includes(createdItem.itemId), text);
        assert.ok(text.includes(createdItem.questionId[0]), text);
      });
    }

    it('honours an explicit index and an optional question', async () => {
      installForm();
      installBatch('batch-create-item.json');

      const res = await callTool(ctx.client, 'addFormQuestion', {
        formId: FORM_ID,
        title: 'Prima domanda',
        questionType: 'SHORT_ANSWER',
        index: 1,
        required: false,
      });
      assertOk(res);

      const body = batchCalls()[0]!.args[0].requestBody;
      assert.deepEqual(body.requests[0].createItem.location, { index: 1 });
      assert.equal(body.requests[0].createItem.item.questionItem.question.required, false);
    });

    it('refuses invalid questions before any batch', async () => {
      installForm();
      installBatch('batch-create-item.json');

      const invalid = [
        { formId: FORM_ID, title: 'Senza opzioni', questionType: 'MULTIPLE_CHOICE' },
        { formId: FORM_ID, title: 'Opzioni duplicate', questionType: 'CHECKBOXES', options: ['A', 'A'] },
        { formId: FORM_ID, title: 'Opzioni non valide', questionType: 'SHORT_ANSWER', options: ['A'] },
        { formId: FORM_ID, title: 'Scala incompleta', questionType: 'SCALE', low: 1 },
        { formId: FORM_ID, title: 'Scala senza limiti', questionType: 'SCALE' },
        { formId: FORM_ID, title: 'Scala invertita', questionType: 'SCALE', low: 5, high: 5 },
        { formId: FORM_ID, title: 'Oltre la fine', questionType: 'SHORT_ANSWER', index: 5 },
      ];

      for (const args of invalid) {
        const res = await callTool(ctx.client, 'addFormQuestion', args);
        assertToolIsRegistered(res);
        assert.equal(res.isError, true, `expected refusal for ${JSON.stringify(args)}: ${textOf(res)}`);
      }
      assert.equal(batchCalls().length, 0, 'no batch for a refused question');
    });
  });

  // -------------------------------------------------------------------------
  // updateFormQuestion
  // -------------------------------------------------------------------------
  describe('updateFormQuestion', () => {
    function maskFields(body: any): string[] {
      return String(body.requests[0].updateItem.updateMask)
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean)
        .sort();
    }

    it('updates only the title of the item at its position', async () => {
      installForm();
      installBatch('batch-update-item.json');

      const res = await callTool(ctx.client, 'updateFormQuestion', {
        formId: FORM_ID,
        formItemId: TURNO_ITEM_ID,
        title: 'Fascia oraria',
      });
      assertOk(res);

      assert.equal(formCalls().length, 1, 'reads the form first');
      assert.equal(formCalls()[0]!.args[0].formId, FORM_ID);
      const batches = batchCalls();
      assert.equal(batches.length, 1, 'exactly one batch');
      const body = batches[0]!.args[0].requestBody;
      assert.deepEqual(body.writeControl, { requiredRevisionId: REVISION_ID });
      assert.equal(body.requests.length, 1, 'exactly one request');

      const update = body.requests[0].updateItem;
      assert.deepEqual(update.location, { index: 2 });
      assert.deepEqual(maskFields(body), ['title']);
      assert.equal(update.item.itemId, TURNO_ITEM_ID);
      assert.equal(update.item.title, 'Fascia oraria');
      assert.equal(update.item.questionItem.question.questionId, TURNO_QUESTION_ID);
      assert.deepEqual(update.item.questionItem.question.choiceQuestion.options, [
        { value: 'Mattina' },
        { value: 'Pomeriggio' },
      ]);
    });

    it('updates description and required together with an exact mask', async () => {
      installForm();
      installBatch('batch-update-item.json');

      const res = await callTool(ctx.client, 'updateFormQuestion', {
        formId: FORM_ID,
        formItemId: NAME_ITEM_ID,
        description: 'Scrivi nome e cognome come sul documento.',
        required: true,
      });
      assertOk(res);

      const body = batchCalls()[0]!.args[0].requestBody;
      assert.equal(body.requests.length, 1, 'exactly one request');
      assert.deepEqual(maskFields(body), ['description', 'questionItem.question.required']);

      const update = body.requests[0].updateItem;
      assert.deepEqual(update.location, { index: 0 });
      assert.equal(update.item.itemId, NAME_ITEM_ID);
      assert.equal(update.item.title, 'Nome e cognome');
      assert.equal(update.item.description, 'Scrivi nome e cognome come sul documento.');
      assert.equal(update.item.questionItem.question.required, true);
      assert.equal(update.item.questionItem.question.textQuestion.paragraph, false);
    });

    it('updates choice options and keeps the choice type', async () => {
      installForm();
      installBatch('batch-update-item.json');

      const res = await callTool(ctx.client, 'updateFormQuestion', {
        formId: FORM_ID,
        formItemId: TURNO_ITEM_ID,
        options: ['Mattina', 'Sera'],
      });
      assertOk(res);

      const body = batchCalls()[0]!.args[0].requestBody;
      assert.equal(body.requests.length, 1, 'exactly one request');
      assert.deepEqual(maskFields(body), ['questionItem.question.choiceQuestion.options']);

      const update = body.requests[0].updateItem;
      assert.deepEqual(update.location, { index: 2 });
      assert.deepEqual(update.item.questionItem.question.choiceQuestion, {
        type: 'RADIO',
        options: [{ value: 'Mattina' }, { value: 'Sera' }],
      });
    });

    it('refuses unknown items, empty updates, options on non-choice questions, and page-break edits before any batch', async () => {
      installForm();
      installBatch('batch-update-item.json');

      const invalid = [
        { formId: FORM_ID, formItemId: 'non-esiste', title: 'X' },
        { formId: FORM_ID, formItemId: TURNO_ITEM_ID },
        { formId: FORM_ID, formItemId: NAME_ITEM_ID, options: ['A'] },
        { formId: FORM_ID, formItemId: PAGE_BREAK_ITEM_ID, required: true },
        { formId: FORM_ID, formItemId: PAGE_BREAK_ITEM_ID, options: ['A'] },
      ];

      for (const args of invalid) {
        const res = await callTool(ctx.client, 'updateFormQuestion', args);
        assertToolIsRegistered(res);
        assert.equal(res.isError, true, `expected refusal for ${JSON.stringify(args)}: ${textOf(res)}`);
      }
      assert.equal(batchCalls().length, 0, 'no batch for a refused update');
    });
  });

  // -------------------------------------------------------------------------
  // deleteFormQuestion
  // -------------------------------------------------------------------------
  describe('deleteFormQuestion', () => {
    it('deletes the item at its read position with the read revision', async () => {
      installForm();
      installBatch('batch-delete-item.json');

      const res = await callTool(ctx.client, 'deleteFormQuestion', {
        formId: FORM_ID,
        formItemId: TURNO_ITEM_ID,
      });
      assertOk(res);

      assert.equal(formCalls().length, 1, 'reads the form first');
      assert.equal(formCalls()[0]!.args[0].formId, FORM_ID);
      const batches = batchCalls();
      assert.equal(batches.length, 1, 'exactly one batch');
      const body = batches[0]!.args[0].requestBody;
      assert.deepEqual(body.writeControl, { requiredRevisionId: REVISION_ID });
      assert.deepEqual(body.requests, [{ deleteItem: { location: { index: 2 } } }]);
    });

    it('refuses an unknown item before any batch', async () => {
      installForm();
      installBatch('batch-delete-item.json');

      const res = await callTool(ctx.client, 'deleteFormQuestion', {
        formId: FORM_ID,
        formItemId: 'non-esiste',
      });
      assertToolIsRegistered(res);
      assert.equal(res.isError, true, textOf(res));
      assert.equal(batchCalls().length, 0);
    });

    it('tells the caller to read the form again after a stale revision', async () => {
      installForm();
      ctx.mocks.forms.service.forms.batchUpdate._setImpl(async () => {
        throw googleError('The requested revision is stale', 400);
      });

      const res = await callTool(ctx.client, 'deleteFormQuestion', {
        formId: FORM_ID,
        formItemId: TURNO_ITEM_ID,
      });
      const text = textOf(res);
      assert.equal(res.isError, true, text);
      assert.match(text, /read[^.]*again/i, text);
      assert.equal(batchCalls().length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // listFormResponses
  // -------------------------------------------------------------------------
  describe('listFormResponses', () => {
    it('lists responses under question titles and passes pagination through', async () => {
      installForm();
      const responses = installResponses();

      const res = await callTool(ctx.client, 'listFormResponses', {
        formId: FORM_ID,
        pageSize: 10,
        pageToken: 'token-1',
      });
      const text = assertOk(res);

      assert.equal(formCalls().length, 1, 'reads the form for question titles');
      assert.equal(formCalls()[0]!.args[0].formId, FORM_ID);

      const listCalls = responseCalls();
      assert.equal(listCalls.length, 1, 'one responses.list');
      assert.equal(listCalls[0]!.args[0].formId, FORM_ID);
      assert.equal(listCalls[0]!.args[0].pageSize, 10);
      assert.equal(listCalls[0]!.args[0].pageToken, 'token-1');
      assert.equal(batchCalls().length, 0, 'listing sends no batch');

      for (const response of responses.responses) {
        assert.ok(text.includes(response.responseId), `answer names ${response.responseId}: ${text}`);
        assert.ok(
          text.includes(response.lastSubmittedTime),
          `answer names ${response.lastSubmittedTime}: ${text}`,
        );
        if (response.respondentEmail) {
          assert.ok(text.includes(response.respondentEmail), `answer names ${response.respondentEmail}: ${text}`);
        }
      }

      for (const title of ['Nome e cognome', 'Turno', 'Note']) {
        assert.ok(text.includes(title), `answer names question ${title}: ${text}`);
      }
      for (const value of [
        'Giulia Bianchi',
        'Mattina',
        'Nessuna nota',
        'Marco Rossi',
        'Pomeriggio',
        'Ho già seguito un corso simile.',
      ]) {
        assert.ok(text.includes(value), `answer names value ${value}: ${text}`);
      }
      for (const questionId of [NAME_QUESTION_ID, TURNO_QUESTION_ID, NOTE_QUESTION_ID]) {
        assert.ok(!text.includes(questionId), `answer does not fall back to questionId ${questionId}: ${text}`);
      }
      assert.ok(text.includes(responses.nextPageToken), `answer names the next page token: ${text}`);
    });

    it('joins several values of a checkbox answer', async () => {
      const checkboxForm = {
        formId: FORM_ID,
        info: { title: 'Iscrizione al corso', description: '', documentTitle: 'Iscrizione al corso' },
        revisionId: REVISION_ID,
        responderUri: 'https://docs.google.com/forms/d/e/1FAIpQLSdIscrizioneCorso2026/viewform',
        publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } },
        items: [
          {
            itemId: 'c1d2e3f4',
            title: 'Lingue conosciute',
            questionItem: {
              question: {
                questionId: 'a1b2c3d4',
                required: false,
                choiceQuestion: {
                  type: 'CHECKBOX',
                  options: [{ value: 'Italiano' }, { value: 'Inglese' }, { value: 'Francese' }],
                },
              },
            },
          },
        ],
      };
      installForm(checkboxForm);
      installResponses({
        responses: [
          {
            responseId: '2_checkbox_response',
            createTime: '2026-02-12T08:00:00.000Z',
            lastSubmittedTime: '2026-02-12T08:00:00.000Z',
            answers: {
              a1b2c3d4: {
                questionId: 'a1b2c3d4',
                textAnswers: { answers: [{ value: 'Italiano' }, { value: 'Inglese' }] },
              },
            },
          },
        ],
        nextPageToken: 'next-checkbox',
      });

      const res = await callTool(ctx.client, 'listFormResponses', { formId: FORM_ID });
      const text = assertOk(res);

      assert.ok(text.includes('Lingue conosciute'), text);
      const joinedLine = text
        .split('\n')
        .find((line) => line.includes('Italiano') && line.includes('Inglese'));
      assert.ok(joinedLine, `checkbox values are joined on one line: ${text}`);
      assert.equal(batchCalls().length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Tool surface
  // -------------------------------------------------------------------------
  describe('tool surface', () => {
    it('registers the six tools with the documented arguments and read-only hints', async () => {
      const { tools } = await ctx.client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool as any]));

      for (const name of NEW_TOOLS) {
        assert.ok(byName.has(name), `missing tool: ${name}`);
      }

      const expectedProps: Record<string, string[]> = {
        createForm: ['title', 'documentTitle', 'description'],
        getForm: ['formId'],
        addFormQuestion: [
          'formId',
          'title',
          'questionType',
          'required',
          'description',
          'options',
          'index',
          'low',
          'high',
          'lowLabel',
          'highLabel',
          'includeTime',
          'includeYear',
        ],
        updateFormQuestion: ['formId', 'formItemId', 'title', 'description', 'required', 'options'],
        deleteFormQuestion: ['formId', 'formItemId'],
        listFormResponses: ['formId', 'pageSize', 'pageToken'],
      };

      for (const [name, props] of Object.entries(expectedProps)) {
        const properties = byName.get(name)!.inputSchema.properties ?? {};
        for (const prop of props) {
          assert.ok(prop in properties, `${name} advertises ${prop}`);
        }
        assert.equal('itemId' in properties, false, `${name} must not advertise itemId`);
      }

      assert.equal(
        byName.get('getForm')!.annotations?.readOnlyHint,
        true,
        'getForm is read-only',
      );
      assert.equal(
        byName.get('listFormResponses')!.annotations?.readOnlyHint,
        true,
        'listFormResponses is read-only',
      );
      for (const name of ['createForm', 'addFormQuestion', 'updateFormQuestion', 'deleteFormQuestion']) {
        assert.notEqual(
          byName.get(name)!.annotations?.readOnlyHint,
          true,
          `${name} must not claim to be read-only`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Google refusals
  // -------------------------------------------------------------------------
  describe('Google refusals', () => {
    it('reach the caller as isError for create, read, batch, and response refusals', async () => {
      resetFakes();
      ctx.mocks.forms.service.forms.create._setImpl(async () => {
        throw googleError('Forbidden', 403);
      });
      let res = await callTool(ctx.client, 'createForm', { title: 'X' });
      assertToolIsRegistered(res);
      assert.equal(res.isError, true, textOf(res));
      assert.match(textOf(res), /Forbidden/);

      resetFakes();
      ctx.mocks.forms.service.forms.get._setImpl(async () => {
        throw googleError('Not found', 404);
      });
      res = await callTool(ctx.client, 'getForm', { formId: FORM_ID });
      assertToolIsRegistered(res);
      assert.equal(res.isError, true, textOf(res));
      assert.match(textOf(res), /Not found/);

      resetFakes();
      installForm();
      ctx.mocks.forms.service.forms.batchUpdate._setImpl(async () => {
        throw googleError('Forbidden', 403);
      });
      res = await callTool(ctx.client, 'addFormQuestion', {
        formId: FORM_ID,
        title: 'X',
        questionType: 'SHORT_ANSWER',
      });
      assertToolIsRegistered(res);
      assert.equal(res.isError, true, textOf(res));
      assert.match(textOf(res), /Forbidden/);

      resetFakes();
      installForm();
      ctx.mocks.forms.service.forms.batchUpdate._setImpl(async () => {
        throw googleError('Not found', 404);
      });
      res = await callTool(ctx.client, 'updateFormQuestion', {
        formId: FORM_ID,
        formItemId: TURNO_ITEM_ID,
        title: 'X',
      });
      assertToolIsRegistered(res);
      assert.equal(res.isError, true, textOf(res));
      assert.match(textOf(res), /Not found/);

      resetFakes();
      installForm();
      ctx.mocks.forms.service.forms.batchUpdate._setImpl(async () => {
        throw googleError('Forbidden', 403);
      });
      res = await callTool(ctx.client, 'deleteFormQuestion', {
        formId: FORM_ID,
        formItemId: TURNO_ITEM_ID,
      });
      assertToolIsRegistered(res);
      assert.equal(res.isError, true, textOf(res));
      assert.match(textOf(res), /Forbidden/);

      resetFakes();
      installForm();
      ctx.mocks.forms.service.forms.responses.list._setImpl(async () => {
        throw googleError('Not found', 404);
      });
      res = await callTool(ctx.client, 'listFormResponses', { formId: FORM_ID });
      assertToolIsRegistered(res);
      assert.equal(res.isError, true, textOf(res));
      assert.match(textOf(res), /Not found/);
    });
  });
});
