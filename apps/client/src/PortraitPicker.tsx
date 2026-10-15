import { SquareLynxCreator, type SquareLynxCreatorProps } from './nova/square-lynx/SquareLynxCreator';

/** Avatar field for agents and the owner profile: one modular square-lynx
 *  creator shared by the agent creation flow and profile editing. */
export function PortraitPicker(props: SquareLynxCreatorProps) {
  return (
    <div className="record-mascot-picker">
      <SquareLynxCreator {...props} />
    </div>
  );
}
