import * as path from 'path';
import {
  requiredPart,
  resolveOpcTarget,
  unzipTextParts,
  xmlAttr,
  xmlElements,
  xmlText,
} from './zipXml';

export function readPptx(bytes: Buffer, abortSignal?: AbortSignal): string {
  const parts = unzipTextParts(bytes, (name) => /\.(?:xml|rels)$/.test(name), abortSignal);
  const presentation = requiredPart(parts, 'ppt/presentation.xml');
  const relationships = requiredPart(parts, 'ppt/_rels/presentation.xml.rels');
  const targets = new Map(
    [...relationships.matchAll(/<Relationship\b[^>]*\/?\s*>/g)].map((match) => [
      xmlAttr(match[0], 'Id') ?? '',
      xmlAttr(match[0], 'Target') ?? '',
    ]),
  );
  const slides = xmlElements(presentation, 'p:sldIdLst')
    .flatMap((list) => [...list.matchAll(/<p:sldId\b[^>]*\/?\s*>/g)])
    .map((match) => targets.get(xmlAttr(match[0], 'r:id') ?? ''))
    .filter((target): target is string => Boolean(target))
    .map((target) => resolveOpcTarget('ppt/presentation.xml', target));
  if (!slides.length) throw new Error('ZIP part "ppt/presentation.xml": no slides found.');
  return slides
    .map((slide, index) => {
      if (abortSignal?.aborted) throw new Error('PPTX parsing cancelled.');
      const xml = requiredPart(parts, slide);
      const texts = xmlElements(xml, 'a:p')
        .map((paragraph) => xmlElements(paragraph, 'a:t').map(xmlText).join(''))
        .filter(Boolean);
      const title = texts[0] ?? `Slide ${index + 1}`;
      const slideName = path.basename(slide);
      const slideDirectory = path.posix.dirname(slide);
      const slideRels = parts.get(`${slideDirectory}/_rels/${slideName}.rels`);
      const notesTarget = slideRels
        ? [...slideRels.matchAll(/<Relationship\b[^>]*\/?\s*>/g)].find((rel) =>
            (xmlAttr(rel[0], 'Type') ?? '').endsWith('/notesSlide'),
          )
        : undefined;
      const notes = notesTarget
        ? parts.get(resolveOpcTarget(slide, xmlAttr(notesTarget[0], 'Target') ?? ''))
        : undefined;
      const noteText = notes
        ? xmlElements(notes, 'a:p')
            .map((p) => xmlElements(p, 'a:t').map(xmlText).join(''))
            .filter(Boolean)
            .join(' ')
        : '';
      return `--- slide ${index + 1} ---\n# ${title}${texts.length > 1 ? `\n${texts.slice(1).join('\n')}` : ''}${noteText ? `\nSpeaker notes: ${noteText}` : ''}`;
    })
    .join('\n\n');
}
