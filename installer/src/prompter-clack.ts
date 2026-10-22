import * as clack from "@clack/prompts";
import { CANCEL } from "./types.ts";
import type { Prompter } from "./types.ts";

function wrap<T>(value: T | symbol): T | typeof CANCEL {
  return clack.isCancel(value) ? CANCEL : (value as T);
}

export function clackPrompter(): Prompter {
  return {
    intro: (title) => clack.intro(title),
    outro: (message) => clack.outro(message),
    note: (body, title) => clack.note(body, title),
    spinner: () => clack.spinner(),
    confirm: async (o) => wrap(await clack.confirm({ message: o.message, initialValue: o.initial })),
    select: async <T extends string>(o: Parameters<Prompter["select"]>[0] & { options: { value: T }[] }) =>
      wrap<T>(
        (await clack.select<T>({
          message: o.message,
          options: o.options as never,
          initialValue: o.initial as T | undefined,
        })) as T | symbol,
      ),
    text: async (o) => wrap(await clack.text({ message: o.message, initialValue: o.initial, validate: o.validate })),
    isCancel: (value) => value === CANCEL || clack.isCancel(value),
  };
}
