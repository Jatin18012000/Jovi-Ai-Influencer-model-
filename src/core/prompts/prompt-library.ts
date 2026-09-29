import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { ValidationError } from '../errors.js';

/**
 * Loads prompt templates from `prompts/` (outside TypeScript source) and
 * renders `{{variable}}` placeholders. Unknown or missing variables fail
 * loudly — a half-rendered prompt is worse than an error.
 */
export class PromptLibrary {
  private readonly cache = new Map<string, string>();

  constructor(private readonly directory: string) {}

  load(name: string): string {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;
    const relative = normalize(`${name}.md`);
    if (relative.startsWith('..') || relative.startsWith('/')) throw new ValidationError(`Invalid prompt name: ${name}`);
    const path = join(this.directory, relative);
    if (!existsSync(path)) throw new ValidationError(`Prompt not found: ${name}`, { path });
    const text = readFileSync(path, 'utf8');
    this.cache.set(name, text);
    return text;
  }

  render(name: string, variables: Record<string, string>): string {
    const template = this.load(name);
    const missing = new Set<string>();
    const rendered = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
      const value = variables[key];
      if (value === undefined) {
        missing.add(key);
        return '';
      }
      return value;
    });
    if (missing.size > 0) {
      throw new ValidationError(`Prompt ${name} is missing variables: ${[...missing].join(', ')}`);
    }
    return rendered.trim();
  }
}
