import { SquareLynxCreator } from './nova/square-lynx/SquareLynxCreator';

/** Avatar field for agents and the owner profile: one modular square-lynx
 *  creator shared by the agent creation flow and profile editing. */
export function PortraitPicker({ value, change, name }: { value: Record<string, unknown> | null; change: (value: Record<string, unknown> | null) => void; name: string }) {
  return (
    <div className="record-portrait-picker">
      <h3>Avatar</h3>
      <p className="metadata">Build a square lynx in the Nova Dream style: pick a pattern, a color, a face and clothing. Each choice only changes its own layer.</p>
      <SquareLynxCreator value={value} change={change} name={name} />
    </div>
  );
}
