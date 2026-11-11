const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/src/main/assets/www/index.html'), 'utf8');
const recordingAI = require('../app/src/main/assets/www/recording-ai.js');
const vertex = {
    slot: 'primary', provider: 'vertex', model: 'gemini-3.7-flash', key: 'test-key',
    url: 'https://aiplatform.googleapis.com/v1/publishers/google'
};
const studio = { ...vertex, provider: 'google', url: 'https://generativelanguage.googleapis.com/v1beta' };
const largePdf = Buffer.alloc(20 * 1024 * 1024, 65);
largePdf.write('%PDF-1.7\n');
largePdf.write('\n%%EOF', largePdf.length - 6);

// Load the production functions without booting the app or touching its stored data.
function functionSource(name) {
    const start = html.search(new RegExp('^        (?:async )?function ' + name + '\\(', 'm'));
    assert.notEqual(start, -1, 'Missing production function: ' + name);
    const end = html.indexOf('\n        }', start);
    return html.slice(start, end + '\n        }'.length);
}

function harness(fetchImpl) {
    const calls = [];
    const notices = [];
    const context = vm.createContext({
        URL, Blob, Response, TextDecoder, TextEncoder, Uint8Array, Date, setTimeout, clearTimeout,
        console: { warn() {}, error() {} },
        window: { RecordingAI: recordingAI },
        i18n: (name, ...args) => [name, ...args].join(': '),
        aiApiName: slot => slot,
        showToast: message => notices.push(message),
        uint8ToBase64: bytes => Buffer.from(bytes).toString('base64'),
        base64ToUint8: text => new Uint8Array(Buffer.from(text, 'base64')),
        _blobToRawBase64: async blob => Buffer.from(await blob.arrayBuffer()).toString('base64'),
        fetch: async (url, init = {}) => {
            calls.push({ url, ...init });
            return fetchImpl ? fetchImpl(url, init) : Response.json({
                candidates: [{ content: { parts: [{ text: 'attachment received' }] }, finishReason: 'STOP' }]
            });
        }
    });
    for (const name of [
        'isVertexGeminiUrl', 'isVertexGeminiConfig', 'isGeminiUrl', 'geminiBaseUrl',
        'geminiUsesFilesApi', 'fetchModels', 'updateDefaultUrl',
        'aiOutputTokenLimitFromError', 'sendAIRequestWithTokenRetry', 'sendAIRequestDroppingRejected',
        'callAI', 'doAIRequestPreferStream', 'doAIRequest', 'doGeminiRequest', 'buildGeminiContentsWithPdf',
        'geminiUploadFile', 'geminiDeleteFile', '_prepareGeminiFileRecordingAi',
        'createThinkTagSplitter', 'aiStreamDeltaText', 'aiResponseText',
        'aiStreamDeltaThinking', 'aiStreamEventIsThinking', 'readAIStream'
    ]) vm.runInContext(functionSource(name), context);
    vm.runInContext('const AI_MAX_OUTPUT_TOKENS = 32800; const aiModelOutputTokenCaps = new Map();', context);
    for (const name of ['defaultAPIUrls', 'AI_API_MODAL_FIELDS']) {
        const start = html.indexOf('        const ' + name + ' = {');
        const end = html.indexOf('\n        };', start);
        vm.runInContext(html.slice(start, end + '\n        };'.length), context);
    }
    return { app: context, calls, notices };
}

test('Vertex Agent is immediately below Gemini in all three provider selectors', () => {
    for (const id of ['apiProvider', 'secondaryProvider', 'backupProvider']) {
        const select = html.match(new RegExp('<select[^>]+id="' + id + '"[^>]*>([\\s\\S]*?)</select>'))[1];
        assert.match(select, /<option value="google">Gemini \(AI Studio\)<\/option>\s*<option value="vertex">Vertex Agent<\/option>/);
    }
    const { app } = harness();
    const controls = Object.fromEntries(['apiProvider', 'secondaryProvider', 'backupProvider'].map(id => [id, { value: 'vertex' }]));
    for (const id of ['modalAiApiUrl', 'secondaryUrl', 'backupUrl']) controls[id] = { value: '' };
    app.document = { getElementById: id => controls[id] };
    for (const slot of ['primary', 'secondary', 'backup']) app.updateDefaultUrl(slot);
    for (const id of ['modalAiApiUrl', 'secondaryUrl', 'backupUrl']) assert.equal(controls[id].value, vertex.url);
});

test('official Vertex hosts and saved custom/google settings select Gemini protocol', async () => {
    const { app, calls } = harness();
    assert.equal(app.isGeminiUrl('https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google'), true);
    assert.equal(app.isGeminiUrl('https://aiplatform.googleapis.com.evil.test/v1'), false);
    assert.equal(app.isGeminiUrl('https://example.test/?host=generativelanguage.googleapis.com'), false);
    for (const provider of ['vertex', 'custom', 'google']) {
        await app.doAIRequest({ ...vertex, provider }, 'system', [{ role: 'user', content: 'read' }], {});
    }
    for (const call of calls) {
        assert.equal(call.url, vertex.url + '/models/gemini-3.7-flash:generateContent?key=test-key');
        assert.equal(JSON.parse(call.body).contents[0].parts[0].text, 'read');
        assert.equal(call.headers.Authorization, undefined);
    }
});

test('base, model-list, and full generation URLs normalize without duplicate paths', () => {
    const { app } = harness();
    for (const suffix of ['', '/', '/models', '/models/', '/models/gemini-3.7-flash:generateContent?key=old', '/models/gemini-3.7-flash:streamGenerateContent?alt=sse']) {
        assert.equal(app.geminiBaseUrl(vertex.url + suffix), vertex.url);
    }
});

test('20 MiB Vertex PDF is sent intact in one generation request, including its last bytes', async () => {
    const { app, calls } = harness();
    const result = await app.doAIRequest(vertex, 'read the complete PDF', [{ role: 'user', content: 'read' }], {
        pdfAttachment: { bytes: largePdf, name: 'large.pdf' }
    });
    assert.equal(result, 'attachment received');
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].url.includes('/upload/'));
    const part = JSON.parse(calls[0].body).contents[0].parts[0];
    assert.equal(part.inline_data.mime_type, 'application/pdf');
    assert.deepEqual(Buffer.from(part.inline_data.data, 'base64'), largePdf);
});

test('Vertex PDF streaming preserves the same attachment and returns SSE text', async () => {
    const { app, calls } = harness(() => new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"Reading PDF","thought":true}]}}]}\n\n' +
        'data: {"candidates":[{"content":{"parts":[{"text":"first "}]}}]}\n\n' +
        'data: {"candidates":[{"content":{"parts":[{"text":"last"}]},"finishReason":"STOP"}]}\n\n' +
        'data: {"usageMetadata":{"totalTokenCount":10}}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } }
    ));
    const updates = [];
    const result = await app.doAIRequestPreferStream(vertex, '', [{ role: 'user', content: 'read' }], {
        pdfAttachment: { bytes: largePdf }, onDelta: (text, thinking) => updates.push({ text, thinking })
    });
    assert.equal(result, 'first last');
    assert.deepEqual(updates.at(-1), { text: 'first last', thinking: 'Reading PDF' });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /:streamGenerateContent\?alt=sse&key=test-key$/);
    assert.deepEqual(Buffer.from(JSON.parse(calls[0].body).contents[0].parts[0].inline_data.data, 'base64'), largePdf);
});

test('AI Studio still uploads PDFs above 18 MiB through its Files API', async () => {
    const { app, calls } = harness((url, init) => {
        if (url.includes('/upload/v1beta/files')) return new Response('', { headers: { 'x-goog-upload-url': 'https://upload.example.test/session' } });
        if (url === 'https://upload.example.test/session') return Response.json({ file: {
            name: 'files/abc', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
            mimeType: 'application/pdf', state: 'ACTIVE'
        } });
        return Response.json({ candidates: [{ content: { parts: [{ text: 'studio received' }] } }] });
    });
    assert.equal(await app.doAIRequest(studio, '', [{ role: 'user', content: 'read' }], { pdfAttachment: { bytes: largePdf } }), 'studio received');
    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /^https:\/\/generativelanguage.googleapis.com\/upload\/v1beta\/files\?/);
    assert.strictEqual(calls[1].body, largePdf);
    assert.equal(JSON.parse(calls[2].body).contents[0].parts[0].file_data.mime_type, 'application/pdf');
});

test('small AI Studio PDFs remain inline and Vertex legacy PDFs use their documented size limit', async () => {
    const { app, calls } = harness();
    await app.doAIRequest(studio, '', [], { pdfAttachment: { bytes: Buffer.from('%PDF') } });
    assert.equal(calls.length, 1);
    assert.equal(app.geminiUsesFilesApi({ ...vertex, model: 'gemini-2.5-flash' }, 50 * 1024 * 1024, 'application/pdf'), false);
    for (const model of ['gemini-2.5-flash', 'gemini-3.1-pro-preview-customtools']) {
        assert.throws(() => app.geminiUsesFilesApi({ ...vertex, model }, 50 * 1024 * 1024 + 1, 'application/pdf'), { code: 'GEMINI_ATTACHMENT_TOO_LARGE' });
    }
});

test('oversized Vertex attachments fail before conversion/upload and retain the actionable error', async () => {
    const { app, calls } = harness();
    assert.equal(app.geminiUsesFilesApi(vertex, 256000000, 'application/pdf'), false);
    app.resolveAIRoute = () => [vertex, { ...studio, slot: 'backup' }];
    app.geminiUploadFile = async () => { throw new Error('backup unavailable'); };
    await assert.rejects(app.callAI('', [{ role: 'user', content: 'read' }], {
        pdfAttachment: { bytes: { byteLength: 256000001 } }, onDelta() {}
    }), { code: 'GEMINI_ATTACHMENT_TOO_LARGE' });
    assert.equal(calls.length, 0);
});

test('Vertex never constructs an AI Studio upload URL even when the upload helper is called directly', async () => {
    const { app, calls } = harness();
    await assert.rejects(app.geminiUploadFile(vertex.url, 'test-key', largePdf, 'application/pdf', 'large.pdf'), /vertex_files_api_unsupported/);
    assert.equal(calls.length, 0);
});

test('large compressed audio remains intact and inline for Vertex', async () => {
    const { app, calls } = harness();
    const blob = new Blob([largePdf], { type: 'audio/mp4' });
    await app.doAIRequest(vertex, '', [{ role: 'user', content: [
        { type: 'audio', audio: { blob, mimeType: 'audio/mp4' } }, { type: 'text', text: 'transcribe' }
    ] }], {});
    assert.equal(calls.length, 1);
    const audio = JSON.parse(calls[0].body).contents[0].parts[0].inline_data;
    assert.equal(audio.mime_type, 'audio/m4a');
    assert.deepEqual(Buffer.from(audio.data, 'base64'), largePdf);
});

test('long Vertex recordings keep the complete compressed blob without Files API or PCM decoding', async () => {
    const { app, calls } = harness();
    app._configuredGeminiRecordingConfig = () => vertex;
    const blob = new Blob([largePdf], { type: 'audio/mp4' });
    const prepared = await app._prepareGeminiFileRecordingAi(blob, 5400, 'classroom_upload_audio');
    assert.equal(prepared.mode, 'gemini-inline');
    assert.equal(prepared.segments.length, 1);
    assert.equal(prepared.segments[0].durationMs, 5400000);
    assert.strictEqual(await prepared.segments[0].load(), blob);
    assert.strictEqual(prepared.segments[0].geminiConfig, vertex);
    await prepared.cleanup();
    assert.equal(calls.length, 0);
});

test('independent Vertex generations start concurrently without a global queue', async () => {
    const releases = [];
    const { app, calls } = harness(() => new Promise(resolve => releases.push(() => resolve(Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })))));
    const request = () => app.doAIRequest(vertex, '', [], { pdfAttachment: { bytes: Buffer.from('%PDF') } });
    const first = request();
    const second = request();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
    releases.forEach(release => release());
    assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok']);
});

test('Vertex model-list button explains API-key limitation without making an invalid request', async () => {
    const { app, calls, notices } = harness();
    const controls = { apiProvider: { value: 'vertex' }, modalAiApiUrl: { value: vertex.url }, modalAiApiKey: { value: 'test-key' }, apiModelSelect: {} };
    app.document = { getElementById: id => controls[id] };
    await app.fetchModels('primary');
    assert.equal(calls.length, 0);
    assert.deepEqual(notices, ['vertex_model_list_requires_oauth']);
});

test('Android and PWA pages match and every inline script parses', () => {
    assert.equal(fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8'), html);
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        if (match[1].trim()) new vm.Script(match[1]);
    }
});

// Optional live smoke test. The fixture is generated locally and contains no user data.
// MATH_READER_GEMINI_API_KEY=... node --test --test-name-pattern='live Vertex' tests/gemini-attachments.test.cjs
test('live Vertex reads a valid PDF larger than 18 MiB', {
    skip: !process.env.MATH_READER_GEMINI_API_KEY, timeout: 120000
}, async () => {
    const chunks = [Buffer.from('%PDF-1.7\n')];
    const offsets = [0];
    let length = chunks[0].length;
    const add = (number, body) => {
        offsets[number] = length;
        const bytes = Buffer.from(number + ' 0 obj\n' + body + '\nendobj\n');
        chunks.push(bytes);
        length += bytes.length;
    };
    add(1, '<< /Type /Catalog /Pages 2 0 R >>');
    add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    add(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
    add(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const content = ('%' + 'A'.repeat(1022) + '\n').repeat(20 * 1024) +
        'BT /F1 20 Tf 40 700 Td (VERTEX_LARGE_PDF_OK) Tj ET\n';
    add(5, '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + 'endstream');
    const xref = length;
    chunks.push(Buffer.from('xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset =>
        String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
        'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'));
    const pdf = Buffer.concat(chunks);
    assert.ok(pdf.length > 18 * 1024 * 1024);
    const { app, calls } = harness(async (url, init) => {
        const response = await fetch(url, init);
        assert.equal(response.status, 200, 'Vertex HTTP status');
        return response;
    });
    const text = await app.doAIRequestPreferStream({ ...vertex, key: process.env.MATH_READER_GEMINI_API_KEY },
        'Read the PDF and return only the text printed on its page.', [{ role: 'user', content: 'What text is printed in this PDF?' }],
        { pdfAttachment: { bytes: pdf, name: 'synthetic-large.pdf' }, maxTokens: 256, onDelta() {} });
    assert.match(text, /VERTEX_LARGE_PDF_OK/);
    assert.equal(calls.length, 1);
});
