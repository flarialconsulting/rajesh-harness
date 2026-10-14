import type { Task } from './store.js';

export function replyFormatting(platform:Task['platform']) {
  if(platform==='whatsapp')return `Replies are read in WhatsApp. Use WhatsApp-native formatting in every user-facing reply, including progress updates and final answers. Write short paragraphs with blank lines between them. Use *single asterisks* for bold, _underscores_ for italics, and ~tildes~ for strikethrough only when useful. Never use **double asterisks** for bold. Prefer plain text; use simple - bullets or numbered lists only when they improve clarity, with no nested lists. Do not use Markdown headings, tables, horizontal rules, or [label](URL) links. Put links as bare URLs, optionally after a short label. Use triple backticks only for literal code or commands, without a language tag. Keep filenames and paths in plain text unless part of code. Avoid decorative formatting and long blocks of bold text. Lead with the answer or result and keep routine updates brief.`;
  return 'Match reply formatting to Discord. Discord does not support advanced Markdown such as tables; use plain paragraphs or simple lists instead.';
}
