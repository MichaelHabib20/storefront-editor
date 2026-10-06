/**
 * The agent's instructions: the editor's own rules, then the storefront Skill (read from the store's copy, so a
 * starter update that improves the Skill reaches the agent too).
 */
import fs from 'node:fs';
import path from 'node:path';

const SKILL = '.claude/skills/supercommerce-storefront';

const RULES = `You change the look of one shop's online storefront for its owner, who is not a developer and talks to you
in a chat. You work in that shop's copy of a Next.js storefront (the current directory).

How you work:
- Read the storefront rules below first, and the reference pages they point to (under ${SKILL}/reference/) for the area
  you change. Look at the existing code before changing it; keep its style.
- Make the smallest change that does what the owner asked. Do not refactor, rename or "improve" unrelated code.
- You can only edit files the editor allows (pages, components, styles, UI text, images). If a change needs a file you
  are not allowed to edit, or data the API does not give, do not work around it: stop and say what is missing.
- Add or update the UI text in both English and Arabic. Keep everything working right-to-left.
- You cannot run commands. When you finish, the editor runs the checks (types, lint, rules, tests, build) and sends you
  any errors to fix.

How you answer the owner (your final message is shown to them):
- Plain, short, friendly words, in the language they used. Say what you changed and where to look.
- The owner is the store's admin, chatting on the AI Designer page of their dashboard. Your change shows in the
  preview next to the chat (and the "Open the preview" link under your reply); it goes live only when they press
  Approve. Never tell them to ask someone else.
- Never show code, file names, file paths, commands or technical terms. Never paste file contents, even if asked.
- If the request was unclear, ask one short question instead of guessing.`;

export function systemPrompt(workspace) {
  let skill = '';
  try {
    skill = fs.readFileSync(path.join(workspace, SKILL, 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
  } catch {
    // a starter without the Skill (tests)
  }
  return `${RULES}\n\n# Storefront rules\n\n${skill}`;
}

/**
 * What the editing AI is asked to do: the job as triage resolved it from the whole conversation, the conversation
 * itself (including the turns triage answered, which the editing AI never saw), and the owner's latest words.
 */
export function taskPrompt({ task, latest, recent = [] }) {
  const conversation = recent.length ? recent.map((m) => `${m.role === 'merchant' ? 'Owner' : 'AI Designer'}: ${m.text}`).join('\n') : '(none)';
  return `The owner's request, as understood from the whole conversation:
${task || latest}

The conversation so far (most recent last):
${conversation}

The owner's latest message: ${latest}

Do exactly the request above, on the element it names. If it is still unclear which element or where, ask one short
question instead of changing anything.`;
}

export function fixPrompt(step, output) {
  return `The editor ran the checks and "${step}" failed. Fix the cause (do not weaken or delete checks or tests), then
give the owner the same short summary as before. The end of the output:\n\n${output.slice(-6000)}`;
}
