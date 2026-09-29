import { SquareLynxCreator } from './nova/square-lynx/SquareLynxCreator';

/** Avatar field for agents and the owner profile: one modular square-lynx
 *  creator shared by the agent creation flow and profile editing. */
export function PortraitPicker({ value, change, name }: { value: Record<string, unknown> | null; change: (value: Record<string, unknown> | null) => void; name: string }) {
  return (
    <div className="record-mascot-picker">
      <SquareLynxCreator value={value} change={change} name={name} />
    </div>
  );
}
