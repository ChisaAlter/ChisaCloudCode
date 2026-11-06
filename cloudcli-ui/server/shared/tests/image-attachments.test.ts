import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendFilesInputTag,
  appendImagesInputTag,
  buildClaudeUserContent,
  buildCodexInputItems,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  isAllowedImageSourcePath,
  normalizeImageDescriptors,
  parseFilesInputTag,
  parseImagesInputTag,
  resolveImageMediaType,
  toImageAttachments,
} from '@/shared/image-attachments.js';

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('normalizeImageDescriptors accepts objects and bare paths, drops junk', () => {
  const descriptors = normalizeImageDescriptors([
    { path: '.cloudcli/assets/a.png', name: 'a.png', mimeType: 'image/png' },
    'scripts/pic.jpg',
    { name: 'no-path.png' },
    42,
    null,
    '',
  ]);

  assert.deepEqual(descriptors, [
    { path: '.cloudcli/assets/a.png', name: 'a.png', mimeType: 'image/png' },
    { path: 'scripts/pic.jpg' },
  ]);
  assert.deepEqual(normalizeImageDescriptors(undefined), []);
  assert.deepEqual(normalizeImageDescriptors('not-an-array'), []);
});

test('normalizeAttachmentDescriptors preserves file metadata and identifies images', () => {
  const [pdf, image] = normalizeAttachmentDescriptors([
    { path: 'brief.pdf', name: 'brief.pdf', mimeType: 'application/pdf', size: 4096 },
    { path: 'diagram.PNG' },
  ]);

  assert.deepEqual(pdf, {
    path: 'brief.pdf',
    name: 'brief.pdf',
    mimeType: 'application/pdf',
    size: 4096,
  });
  assert.equal(isImageAttachmentDescriptor(pdf), false);
  assert.equal(isImageAttachmentDescriptor(image), true);
});

test('appendFilesInputTag and parseFilesInputTag round-trip non-image files', () => {
  const prompt = 'Summarize the attached materials.';
  const tagged = appendFilesInputTag(prompt, [
    { path: 'C:\\Users\\x\\.cloudcli\\assets\\brief.pdf', name: 'Brief (final).pdf' },
    { path: '/tmp/cloudcli-assets/data.csv', name: 'data.csv' },
  ]);

  assert.ok(tagged.includes('<files_input>'));
  assert.ok(tagged.includes('The user attached 2 file(s)'));
  assert.deepEqual(parseFilesInputTag(tagged), {
    text: prompt,
    filePaths: [
      'C:/Users/x/.cloudcli/assets/brief.pdf',
      '/tmp/cloudcli-assets/data.csv',
    ],
    attachments: [
      { path: 'C:/Users/x/.cloudcli/assets/brief.pdf', name: 'Brief final.pdf' },
      { path: '/tmp/cloudcli-assets/data.csv', name: 'data.csv' },
    ],
  });
});

test('parseFilesInputTag handles Windows-flattened provider prompts', () => {
  const flattened = appendFilesInputTag(
    'inspect this',
    [{ path: 'C:/Users/x/.cloudcli/assets/report.docx', name: 'report.docx' }],
  ).replace(/\s*\r?\n\s*/g, ' ');

  const parsed = parseFilesInputTag(flattened);
  assert.equal(parsed.text, 'inspect this');
  assert.deepEqual(parsed.attachments, [
    { path: 'C:/Users/x/.cloudcli/assets/report.docx', name: 'report.docx' },
  ]);
});

test('appendImagesInputTag and parseImagesInputTag round-trip', () => {
  const prompt = 'Describe these screenshots.\n\nFocus on the header.';
  const tagged = appendImagesInputTag(prompt, [
    { path: '.cloudcli/assets/1-a.png' },
    { path: '.cloudcli\\assets\\2-b.jpg' },
  ]);

  assert.ok(tagged.startsWith(prompt));
  assert.ok(tagged.includes('<images_input>'));
  assert.ok(tagged.includes('</images_input>'));
  assert.ok(tagged.includes('The user attached 2 image(s)'));

  const parsed = parseImagesInputTag(tagged);
  assert.equal(parsed.text, prompt);
  // Backslashes are normalized so references stay portable.
  assert.deepEqual(parsed.imagePaths, ['.cloudcli/assets/1-a.png', '.cloudcli/assets/2-b.jpg']);
});

test('original filenames round-trip through the tag', () => {
  const tagged = appendImagesInputTag('compare these', [
    { path: 'C:/Users/x/.cloudcli/assets/1-a.png', name: 'screenshot (final).png' },
    { path: 'C:/Users/x/.cloudcli/assets/2-b.jpg' },
  ]);

  const parsed = parseImagesInputTag(tagged);
  assert.equal(parsed.text, 'compare these');
  // Parentheses are dropped from names so the "(original name: ...)" suffix
  // stays parseable; the path-only entry carries no name.
  assert.deepEqual(parsed.attachments, [
    { path: 'C:/Users/x/.cloudcli/assets/1-a.png', name: 'screenshot final.png' },
    { path: 'C:/Users/x/.cloudcli/assets/2-b.jpg' },
  ]);
});

test('only the LAST images_input block is treated as the attachment carrier', () => {
  const userTypedTag = 'What does <images_input> mean in this codebase?';
  const tagged = appendImagesInputTag(
    `${userTypedTag}\n\n<images_input>\nfake user block\n</images_input>\n\nAlso check this.`,
    [{ path: 'C:/Users/x/.cloudcli/assets/real.png' }],
  );

  const parsed = parseImagesInputTag(tagged);
  assert.ok(parsed.text.includes('fake user block'));
  assert.ok(parsed.text.includes('Also check this.'));
  assert.deepEqual(parsed.imagePaths, ['C:/Users/x/.cloudcli/assets/real.png']);
});

test('appendImagesInputTag without images returns the prompt untouched', () => {
  assert.equal(appendImagesInputTag('hello', []), 'hello');
  assert.equal(appendImagesInputTag('hello', undefined), 'hello');
});

test('parseImagesInputTag handles prompts flattened to one line for cmd.exe shims', () => {
  // Windows spawn runtimes collapse newlines before passing the argument to
  // .cmd-shimmed CLIs; the persisted prompt is then a single line.
  const flattened = appendImagesInputTag('now?', [{ path: 'C:/Users/x/.cloudcli/assets/a.jpg' }])
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim();

  assert.ok(!flattened.includes('\n'));
  const parsed = parseImagesInputTag(flattened);
  assert.equal(parsed.text, 'now?');
  assert.deepEqual(parsed.imagePaths, ['C:/Users/x/.cloudcli/assets/a.jpg']);
});

test('parseImagesInputTag leaves text without a tag untouched', () => {
  const text = 'Just a normal prompt with [brackets] and JSON ["like"] content.';
  const parsed = parseImagesInputTag(text);
  assert.equal(parsed.text, text);
  assert.deepEqual(parsed.imagePaths, []);
});

test('parseImagesInputTag strips a malformed tag body without attaching images', () => {
  const text = 'prompt\n\n<images_input>\nnot json here\n</images_input>';
  const parsed = parseImagesInputTag(text);
  assert.equal(parsed.text, 'prompt');
  assert.deepEqual(parsed.imagePaths, []);
});

test('toImageAttachments maps paths to posix attachment records', () => {
  assert.deepEqual(toImageAttachments(['a\\b\\c.png', 'd/e.jpg']), [
    { path: 'a/b/c.png' },
    { path: 'd/e.jpg' },
  ]);
});

test('resolveImageMediaType prefers the mime type and falls back to the extension', () => {
  assert.equal(resolveImageMediaType({ path: 'x.bin', mimeType: 'image/webp' }), 'image/webp');
  assert.equal(resolveImageMediaType({ path: 'x.JPG' }), 'image/jpeg');
  assert.equal(resolveImageMediaType({ path: 'x.png' }), 'image/png');
  assert.equal(resolveImageMediaType({ path: 'x.unknown' }), null);
});

test('Claude consumes the verified snapshot after the original pathname is replaced', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'image-attachments-'));
  const originalPath = path.join(tempDir, 'shot.png');
  try {
    await writeFile(originalPath, PNG_BYTES);
    const snapshot = { path: originalPath, mimeType: 'image/png', size: PNG_BYTES.length, bytes: Buffer.from(PNG_BYTES) };
    await rename(originalPath, path.join(tempDir, 'verified-original.png'));
    await writeFile(originalPath, Buffer.from('replacement secret'));
    const content = await buildClaudeUserContent('What is in this image?', [snapshot]);
    assert.deepEqual(content, [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BYTES.toString('base64') } },
    ]);
  } finally { await rm(tempDir, { recursive: true, force: true }); }
});

test('Claude never opens the snapshot path and rejects missing or mismatched bytes', async () => {
  const snapshot = { path: 'missing.png', mimeType: 'image/png', size: PNG_BYTES.length, bytes: PNG_BYTES };
  assert.equal((await buildClaudeUserContent('prompt', [snapshot])).length, 2);
  await assert.rejects(buildClaudeUserContent('prompt', [{ path: 'missing.png', mimeType: 'image/png' }] as never), /verified raster bytes/);
  await assert.rejects(buildClaudeUserContent('prompt', [{ ...snapshot, size: 1 }]), /verified raster bytes/);
  await assert.rejects(buildClaudeUserContent('prompt', [{ ...snapshot, mimeType: 'image/svg+xml' }]), /verified raster bytes/);
});

test('Codex preserves an already prepared absolute snapshot path without resolving it', () => {
  const preparedPath = path.join(os.tmpdir(), 'private-snapshot', 'attachment-0.png');
  assert.deepEqual(buildCodexInputItems('Describe this image:', [{ path: preparedPath }]), [
    { type: 'text', text: 'Describe this image:' }, { type: 'local_image', path: preparedPath },
  ]);
  assert.throws(() => buildCodexInputItems('prompt', [{ path: 'client-relative.png' }]), /prepared absolute/);
});

test('isAllowedImageSourcePath only accepts the upload store and the run cwd', () => {
  const cwd = path.join(os.tmpdir(), 'some-project');
  const uploadStore = path.join(os.homedir(), '.cloudcli', 'assets');

  assert.equal(isAllowedImageSourcePath(path.join(uploadStore, 'shot.png'), cwd), true);
  assert.equal(isAllowedImageSourcePath(path.join(cwd, 'docs', 'diagram.png'), cwd), true);

  assert.equal(isAllowedImageSourcePath(path.join(os.homedir(), '.ssh', 'id_rsa'), cwd), false);
  assert.equal(isAllowedImageSourcePath(path.join(cwd, '..', 'other-project', 'x.png'), cwd), false);
  // The roots themselves are directories, not readable image files.
  assert.equal(isAllowedImageSourcePath(cwd, cwd), false);
});

test('descriptor normalization never accepts caller-provided verified bytes', () => {
  const descriptors = normalizeAttachmentDescriptors([{ path: 'photo.png', mimeType: 'image/png', bytes: PNG_BYTES }]);
  assert.deepEqual(descriptors, [{ path: 'photo.png', mimeType: 'image/png' }]);
});
