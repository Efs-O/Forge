import { describe, expect, it } from 'vitest';
import { validateAttachments } from '../../src/sidebar/attachmentValidation';

describe('attachment validation', () => {
  it('accepts a supported text attachment', () => {
    expect(
      validateAttachments([{ name: 'notes.md', mediaType: 'text/markdown', data: '# Notes' }]),
    ).toBeNull();
  });

  it('rejects unsupported documents instead of treating binary bytes as text', () => {
    expect(
      validateAttachments([{ name: 'report.pdf', mediaType: 'application/pdf', data: 'x' }]),
    ).toContain('unsupported');
  });

  it('rejects text attachments above 2 MiB', () => {
    expect(
      validateAttachments([
        { name: 'large.txt', mediaType: 'text/plain', data: 'x'.repeat(2 * 1024 * 1024 + 1) },
      ]),
    ).toContain('2 MiB');
  });
});
