import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { overlapScore, tokenize, truncate } from '../text.js';

export interface KnowledgeSection {
  document: string;
  heading: string;
  content: string;
  tokens: string[];
}

export interface KnowledgeMatch {
  document: string;
  heading: string;
  excerpt: string;
  relevance: number;
}

/**
 * Markdown knowledge base (knowledge/jovi/*.md). Documents are human-authored
 * sources of truth; this class only reads them and splits by heading so the
 * Context Engine can pull the few relevant sections instead of whole files.
 */
export class KnowledgeBase {
  private sections: KnowledgeSection[] = [];
  private documents = new Map<string, string>();

  constructor(private readonly directory: string) {
    this.reload();
  }

  reload(): void {
    this.sections = [];
    this.documents.clear();
    if (!existsSync(this.directory)) return;
    for (const file of readdirSync(this.directory).filter((f) => f.endsWith('.md')).sort()) {
      const name = basename(file, '.md');
      const text = readFileSync(join(this.directory, file), 'utf8');
      this.documents.set(name, text);
      this.sections.push(...splitSections(name, text));
    }
  }

  listDocuments(): string[] {
    return [...this.documents.keys()];
  }

  getDocument(name: string): string | undefined {
    return this.documents.get(name);
  }

  search(query: string, limit = 4, maxExcerpt = 700): KnowledgeMatch[] {
    const q = tokenize(query);
    return this.sections
      .map((s) => ({ section: s, relevance: overlapScore(q, s.tokens) }))
      .filter((m) => m.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit)
      .map(({ section, relevance }) => ({
        document: section.document,
        heading: section.heading,
        excerpt: truncate(section.content, maxExcerpt),
        relevance,
      }));
  }
}

function splitSections(document: string, markdown: string): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  let heading = document;
  let buffer: string[] = [];
  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content) sections.push({ document, heading, content, tokens: tokenize(`${heading} ${content}`) });
    buffer = [];
  };
  for (const line of markdown.split('\n')) {
    const match = /^#{1,3}\s+(.*)$/.exec(line);
    if (match?.[1]) {
      flush();
      heading = match[1].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}
