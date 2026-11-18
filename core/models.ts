// Which model the agent and the drawing workers run on, and how hard they
// think. Set from the settings, for every project at once: kept in tandem's
// state file beside the project that was open last. Each round reads it when it
// starts, so a change counts from the next round on. Not set, TANDEM_MODEL and
// TANDEM_EFFORT (TANDEM_ART_MODEL and TANDEM_ART_EFFORT for the workers) say it.
import { CommandError, type CommandDef } from './commands.ts';
import { readState, writeState } from './projects.ts';

export const MODELS = [
  { id: 'claude-fable-5-2', name: 'Fable 5.2' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export type Who = 'agent' | 'workers';
export interface Choice { model: string; effort: string }

function fallback(who: Who): Choice {
  const env = process.env;
  return who === 'agent'
    ? { model: env.TANDEM_MODEL ?? 'claude-fable-5-2', effort: env.TANDEM_EFFORT ?? 'medium' }
    : { model: env.TANDEM_ART_MODEL ?? env.TANDEM_MODEL ?? 'claude-fable-5-2', effort: env.TANDEM_ART_EFFORT ?? 'high' };
}

export function modelFor(who: Who): Choice {
  return { ...fallback(who), ...readState().models?.[who] };
}

export function modelCommands(): CommandDef[] {
  return [
    {
      name: 'models.get', kind: 'read',
      about: 'Which model the agent and the drawing workers run on and with what effort, and what can be chosen.',
      run: () => ({ agent: modelFor('agent'), workers: modelFor('workers'), models: MODELS, efforts: EFFORTS }),
    },
    {
      name: 'models.set', kind: 'write',
      about: 'Choose the model and the effort for the agent or for the drawing workers (who: agent or workers), for every project; it counts from the next round. Only the person does this.',
      input: { who: 'string', model: 'string?', effort: 'string?' },
      run(_c, i) {
        if (i.who !== 'agent' && i.who !== 'workers') throw new CommandError('input', 'who is agent or workers');
        if (i.model !== undefined && !MODELS.some((m) => m.id === i.model)) throw new CommandError('input', `there is no model ${i.model}; it is one of ${MODELS.map((m) => m.id).join(', ')}`);
        if (i.effort !== undefined && !EFFORTS.includes(i.effort)) throw new CommandError('input', `effort is one of ${EFFORTS.join(', ')}`);
        const state = readState();
        const who = i.who as Who;
        const now = { ...state.models?.[who], ...(i.model !== undefined && { model: i.model }), ...(i.effort !== undefined && { effort: i.effort }) };
        writeState({ ...state, models: { ...state.models, [who]: now } });
        return modelFor(who);
      },
    },
  ];
}
