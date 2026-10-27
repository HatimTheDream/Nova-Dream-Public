/**
 * Prepare an exact six-artifact packet; never install or start its source.
 * Identity fix: upstream #162033, bee5d85d423c07bb5f8d82492c5351c3d7394fb7.
 * Prerequisite new-row alias admission is already present in its parent,
 * 32339db16b0d4af32b9925e46c59f660ec816d42, session-sharing-preparation.ts:547-563.
 * These prerequisites and the identity fix form the reviewed source contract.
 * MIT License
 *
 * Copyright (c) 2026 OpenClaw Foundation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 */
export const UPSTREAM_COMMIT = "bee5d85d423c07bb5f8d82492c5351c3d7394fb7";
export const REVIEWED_RUNTIME_VERSION = "2026.9.8";
export const REVIEWED_ARTIFACTS = [
  {
    "path": "dist/session-accessor.sqlite-entry-cache-DYTBofzQ.mjs",
    "inputSha256": "7ee95b7badc02cb96dc603e42bdaceca6ed37b0a474f66c8b313cd1979899c0d",
    "inputBytes": 35429,
    "outputSha256": "96b948a0b80bce3cfb0322105f8b4d540486d5bc30d5e7f6026042193d6d7272",
    "outputBytes": 35670,
    "hunks": [
      {
        "name": "publication-physical-identity",
        "before": "function assertSessionEntryCreationPublication(operation, target) {\n\tconst creation = preparedSharingChanges.operations.get(operation);\n\tassertCreationCurrent(creation);\n\tconst sourcePath = creation.source.kind === \"native\" ? creation.source.database.path : creation.source.path;\n\tif (creation.agentId !== target.agentId || creation.sessionKey !== target.sessionKey || !target.paths.has(path.resolve(sourcePath))) throw new Error(\"Session creation publication owner is no longer current\");\n}",
        "after": "function assertSessionEntryCreationPublication(operation, target) {\n\tconst creation = preparedSharingChanges.operations.get(operation);\n\tassertCreationCurrent(creation);\n\tconst sourcePath = creation.source.kind === \"native\" ? creation.source.database.path : creation.source.path;\n\tconst matchesDatabaseIdentity = creation.source.kind === \"file\" && target.databaseIdentity === `file:${creation.source.databaseIdentity}`;\n\tconst matchesTarget = target.databaseIdentity !== void 0 ? matchesDatabaseIdentity : target.paths.has(path.resolve(sourcePath));\n\tif (creation.agentId !== target.agentId || creation.sessionKey !== target.sessionKey || !matchesTarget) throw new Error(\"Session creation publication owner is no longer current\");\n}",
        "count": 1,
        "beforeSha256": "a921b106783a4766a20a45871cfd3ebfc8b9137b1d6177850d4001359ab579e2",
        "afterSha256": "1135d5f5ec432d9b5787ee0234c90743caf63c27c2fc0e9c9bf2d03887f3d495"
      }
    ]
  },
  {
    "path": "dist/session-sharing-preparation-oVvA_geF.mjs",
    "inputSha256": "21e2e4c38118f3761fad7485d5d0c7eba1fe8cd44c6f849951a43b014c09e7e8",
    "inputBytes": 17983,
    "outputSha256": "3ca7df9abda8f9d10a1cb7f29827aae65c9d46ea86e93b68d40d3149f66605a0",
    "outputBytes": 18180,
    "hunks": [
      {
        "name": "selected-identity-declaration",
        "before": "\tlet assertSource;\n\tconst selectedPaths = /* @__PURE__ */ new Set();",
        "after": "\tlet assertSource;\n\tconst selectedPaths = /* @__PURE__ */ new Set();\n\tlet selectedDatabaseIdentity;",
        "count": 1,
        "beforeSha256": "d385f56b781893bab7b10c4c39000fe10021cdde21c6ac66451737e49462b722",
        "afterSha256": "0faa51ad583a09764f3629142353173991bd4e3ca8382c54cb392366332465c2"
      },
      {
        "name": "move-alias-admission-from-existing-row",
        "before": "\t\t\t\tconst sourceCandidates = discoveryCandidates.filter((candidate) => matchesAgentDatabaseReadCandidatePath({\n\t\t\t\t\t...candidate,\n\t\t\t\t\tpath: candidate.physicalPath\n\t\t\t\t}, sharing.source.path));\n\t\t\t\tif (sourceCandidates.length === 0) throw new SessionMutationFactsUnavailableError();\n\t\t\t\tfor (const candidate of sourceCandidates) selectedPaths.add(path.resolve(candidate.path));\n",
        "after": "",
        "count": 1,
        "beforeSha256": "ea72440e572e8e13f7d0d1f0ac866b01c842d66ff3e948e45010515220c36404",
        "afterSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      },
      {
        "name": "new-and-existing-row-alias-admission",
        "before": "\t\t\tif (sharing) selectedPaths.add(path.resolve(sharing.source.path));",
        "after": "\t\t\tif (sharing) {\n\t\t\t\tselectedPaths.add(path.resolve(sharing.source.path));\n\t\t\t\tconst sourceCandidates = discoveryCandidates.filter((candidate) => matchesAgentDatabaseReadCandidatePath({\n\t\t\t\t\t...candidate,\n\t\t\t\t\tpath: candidate.physicalPath\n\t\t\t\t}, sharing.source.path));\n\t\t\t\tif (sourceCandidates.length === 0) throw new SessionMutationFactsUnavailableError();\n\t\t\t\tfor (const candidate of sourceCandidates) selectedPaths.add(path.resolve(candidate.path));\n\t\t\t\tselectedDatabaseIdentity = sharing.databaseIdentity;\n\t\t\t}",
        "count": 1,
        "beforeSha256": "d63d30168e5688ce6b882f0b7ca8f9322782ed6a3cacf4f601460230f678ada5",
        "afterSha256": "fb648ce2f7da96837a9f25032fe9cb050d53febcb5269212fbc20d30f6f88005"
      },
      {
        "name": "both-publication-identity-arguments",
        "before": "paths: selectedPaths\n",
        "after": "paths: selectedPaths,\n\t\t\t\t\tdatabaseIdentity: selectedDatabaseIdentity\n",
        "count": 2,
        "beforeSha256": "e6bf67b6f50faece59680ea6f8e499245ab2820cd8831f286259676b9f4ab9e6",
        "afterSha256": "e0ade62c061cfd3bc63b59adae9c8c4ee06ac1eaa79242a1339cd5e2f3f7c4a2"
      }
    ]
  },
  {
    "path": "dist/package-update-activation-recovery.mjs",
    "inputSha256": "e08dfc1fb3ba7962f9e01d7a6770117c6cd77406b3fa4f7ba94788a670030ba0",
    "inputBytes": 66255827,
    "outputSha256": "7d9a3642134021f1231947a8cfc52ecdfa2df925495883681df039e50a0fb7ad",
    "outputBytes": 66256265,
    "hunks": [
      {
        "name": "publication-physical-identity",
        "before": "function assertSessionEntryCreationPublication(operation, target) {\n\tconst creation = preparedSharingChanges.operations.get(operation);\n\tassertCreationCurrent(creation);\n\tconst sourcePath = creation.source.kind === \"native\" ? creation.source.database.path : creation.source.path;\n\tif (creation.agentId !== target.agentId || creation.sessionKey !== target.sessionKey || !target.paths.has(path.resolve(sourcePath))) throw new Error(\"Session creation publication owner is no longer current\");\n}",
        "after": "function assertSessionEntryCreationPublication(operation, target) {\n\tconst creation = preparedSharingChanges.operations.get(operation);\n\tassertCreationCurrent(creation);\n\tconst sourcePath = creation.source.kind === \"native\" ? creation.source.database.path : creation.source.path;\n\tconst matchesDatabaseIdentity = creation.source.kind === \"file\" && target.databaseIdentity === `file:${creation.source.databaseIdentity}`;\n\tconst matchesTarget = target.databaseIdentity !== void 0 ? matchesDatabaseIdentity : target.paths.has(path.resolve(sourcePath));\n\tif (creation.agentId !== target.agentId || creation.sessionKey !== target.sessionKey || !matchesTarget) throw new Error(\"Session creation publication owner is no longer current\");\n}",
        "count": 1,
        "beforeSha256": "a921b106783a4766a20a45871cfd3ebfc8b9137b1d6177850d4001359ab579e2",
        "afterSha256": "1135d5f5ec432d9b5787ee0234c90743caf63c27c2fc0e9c9bf2d03887f3d495"
      },
      {
        "name": "selected-identity-declaration",
        "before": "\tlet assertSource;\n\tconst selectedPaths = /* @__PURE__ */ new Set();",
        "after": "\tlet assertSource;\n\tconst selectedPaths = /* @__PURE__ */ new Set();\n\tlet selectedDatabaseIdentity;",
        "count": 1,
        "beforeSha256": "d385f56b781893bab7b10c4c39000fe10021cdde21c6ac66451737e49462b722",
        "afterSha256": "0faa51ad583a09764f3629142353173991bd4e3ca8382c54cb392366332465c2"
      },
      {
        "name": "move-alias-admission-from-existing-row",
        "before": "\t\t\t\tconst sourceCandidates = discoveryCandidates.filter((candidate) => matchesAgentDatabaseReadCandidatePath({\n\t\t\t\t\t...candidate,\n\t\t\t\t\tpath: candidate.physicalPath\n\t\t\t\t}, sharing.source.path));\n\t\t\t\tif (sourceCandidates.length === 0) throw new SessionMutationFactsUnavailableError();\n\t\t\t\tfor (const candidate of sourceCandidates) selectedPaths.add(path.resolve(candidate.path));\n",
        "after": "",
        "count": 1,
        "beforeSha256": "ea72440e572e8e13f7d0d1f0ac866b01c842d66ff3e948e45010515220c36404",
        "afterSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      },
      {
        "name": "new-and-existing-row-alias-admission",
        "before": "\t\t\tif (sharing) selectedPaths.add(path.resolve(sharing.source.path));",
        "after": "\t\t\tif (sharing) {\n\t\t\t\tselectedPaths.add(path.resolve(sharing.source.path));\n\t\t\t\tconst sourceCandidates = discoveryCandidates.filter((candidate) => matchesAgentDatabaseReadCandidatePath({\n\t\t\t\t\t...candidate,\n\t\t\t\t\tpath: candidate.physicalPath\n\t\t\t\t}, sharing.source.path));\n\t\t\t\tif (sourceCandidates.length === 0) throw new SessionMutationFactsUnavailableError();\n\t\t\t\tfor (const candidate of sourceCandidates) selectedPaths.add(path.resolve(candidate.path));\n\t\t\t\tselectedDatabaseIdentity = sharing.databaseIdentity;\n\t\t\t}",
        "count": 1,
        "beforeSha256": "d63d30168e5688ce6b882f0b7ca8f9322782ed6a3cacf4f601460230f678ada5",
        "afterSha256": "fb648ce2f7da96837a9f25032fe9cb050d53febcb5269212fbc20d30f6f88005"
      },
      {
        "name": "both-publication-identity-arguments",
        "before": "paths: selectedPaths\n",
        "after": "paths: selectedPaths,\n\t\t\t\t\tdatabaseIdentity: selectedDatabaseIdentity\n",
        "count": 2,
        "beforeSha256": "e6bf67b6f50faece59680ea6f8e499245ab2820cd8831f286259676b9f4ab9e6",
        "afterSha256": "e0ade62c061cfd3bc63b59adae9c8c4ee06ac1eaa79242a1339cd5e2f3f7c4a2"
      }
    ]
  },
  {
    "path": "dist/worker/sqlite-store.worker.mjs",
    "inputSha256": "168be2b4e38f9e3a6b0682ddc45c04e6f7bcfe31ab3d0bdb08e548f13cfecca2",
    "inputBytes": 49455296,
    "outputSha256": "0274b60ee116724e7e490e86c1ec2a98f5de14a89a1dbf23156f8312e4dcffe6",
    "outputBytes": 49455571,
    "hunks": [
      {
        "name": "publication-physical-identity",
        "before": "function assertSessionEntryCreationPublication(Ot,Kt){let Zt=preparedSharingChanges.operations.get(Ot);assertCreationCurrent(Zt);let _n=Zt.source.kind===`native`?Zt.source.database.path:Zt.source.path;if(Zt.agentId!==Kt.agentId||Zt.sessionKey!==Kt.sessionKey||!Kt.paths.has(path.resolve(_n)))throw Error(`Session creation publication owner is no longer current`)}",
        "after": "function assertSessionEntryCreationPublication(Ot,Kt){let Zt=preparedSharingChanges.operations.get(Ot);assertCreationCurrent(Zt);let _n=Zt.source.kind===`native`?Zt.source.database.path:Zt.source.path;if(Zt.agentId!==Kt.agentId||Zt.sessionKey!==Kt.sessionKey||(Kt.databaseIdentity!==void 0?!(Zt.source.kind===`file`&&Kt.databaseIdentity===`file:${Zt.source.databaseIdentity}`):!Kt.paths.has(path.resolve(_n))))throw Error(`Session creation publication owner is no longer current`)}",
        "count": 1,
        "beforeSha256": "90f450eaf9ea2f4cab44b85cf6b6c57bd8502fbd6ad3caa439cc145211ec73a9",
        "afterSha256": "e629439c1a23fb01bf1f288985e4ee2cd894a581f35b2c3f6db6694e03e6a39f"
      },
      {
        "name": "selected-identity-declaration",
        "before": "pr,xr,Mr,assertSource,Pr=/* @__PURE__ */ new Set",
        "after": "pr,xr,Mr,assertSource,selectedDatabaseIdentity,Pr=/* @__PURE__ */ new Set",
        "count": 1,
        "beforeSha256": "125d7204dc8ee9802e6cbb964ad062a8b2acab32a971d553ca6c9dfd78c9cf1e",
        "afterSha256": "564f2734cae87278eb9d04e48ad3e392e7a638cef8d1d2eb5f679b1560b43c42"
      },
      {
        "name": "move-alias-admission-from-existing-row",
        "before": "let Zt=Kt.filter(Ot=>matchesAgentDatabaseReadCandidatePath({...Ot,path:Ot.physicalPath},wi.source.path));if(Zt.length===0)throw new SessionMutationFactsUnavailableError;for(let Ot of Zt)Pr.add(path.resolve(Ot.path));",
        "after": "",
        "count": 1,
        "beforeSha256": "64c0b51155a1c33a2670570a93a6e5373af260a833c279d3c541e4cc42b1efa9",
        "afterSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      },
      {
        "name": "new-and-existing-row-alias-admission",
        "before": "if(Pr.add(path.resolve(Jn.storePath)),wi&&Pr.add(path.resolve(wi.source.path)),xr){",
        "after": "Pr.add(path.resolve(Jn.storePath));if(wi){Pr.add(path.resolve(wi.source.path));let Zt=Kt.filter(Ot=>matchesAgentDatabaseReadCandidatePath({...Ot,path:Ot.physicalPath},wi.source.path));if(Zt.length===0)throw new SessionMutationFactsUnavailableError;for(let Ot of Zt)Pr.add(path.resolve(Ot.path));selectedDatabaseIdentity=wi.databaseIdentity}if(xr){",
        "count": 1,
        "beforeSha256": "1f22a394a1f00c1bbb97ca35c709af2f5f25e60a7564d07662542b098d0e03fa",
        "afterSha256": "ebc9906e1da6d41379d0ca6327f266b7591c1b324d734ebd997af444ad3e2723"
      },
      {
        "name": "both-publication-identity-arguments",
        "before": "sessionKey:Zt,paths:Pr}",
        "after": "sessionKey:Zt,paths:Pr,databaseIdentity:selectedDatabaseIdentity}",
        "count": 2,
        "beforeSha256": "def726c2142af0dbcc0ae090868d035b77a063a75015fbd025e7d1c361a45b07",
        "afterSha256": "dc452673bb800062ffc2f892671bbd1082b0c6a839ceafda7b439844c14006fa"
      }
    ]
  },
  {
    "path": "dist/worker/worker.mjs",
    "inputSha256": "45da9962621c5dee917f56e315d2abf7161bc5f31297e2e8361343d7f9e69294",
    "inputBytes": 55473425,
    "outputSha256": "48158d2e66966ce5076e77fbfa4c6824729f422a4e33ea590a43e620853fa639",
    "outputBytes": 55473700,
    "hunks": [
      {
        "name": "publication-physical-identity",
        "before": "function assertSessionEntryCreationPublication(Ot,Kt){let Zt=preparedSharingChanges.operations.get(Ot);assertCreationCurrent(Zt);let _n=Zt.source.kind===`native`?Zt.source.database.path:Zt.source.path;if(Zt.agentId!==Kt.agentId||Zt.sessionKey!==Kt.sessionKey||!Kt.paths.has(path.resolve(_n)))throw Error(`Session creation publication owner is no longer current`)}",
        "after": "function assertSessionEntryCreationPublication(Ot,Kt){let Zt=preparedSharingChanges.operations.get(Ot);assertCreationCurrent(Zt);let _n=Zt.source.kind===`native`?Zt.source.database.path:Zt.source.path;if(Zt.agentId!==Kt.agentId||Zt.sessionKey!==Kt.sessionKey||(Kt.databaseIdentity!==void 0?!(Zt.source.kind===`file`&&Kt.databaseIdentity===`file:${Zt.source.databaseIdentity}`):!Kt.paths.has(path.resolve(_n))))throw Error(`Session creation publication owner is no longer current`)}",
        "count": 1,
        "beforeSha256": "90f450eaf9ea2f4cab44b85cf6b6c57bd8502fbd6ad3caa439cc145211ec73a9",
        "afterSha256": "e629439c1a23fb01bf1f288985e4ee2cd894a581f35b2c3f6db6694e03e6a39f"
      },
      {
        "name": "selected-identity-declaration",
        "before": "pr,xr,Mr,assertSource,Pr=/* @__PURE__ */ new Set",
        "after": "pr,xr,Mr,assertSource,selectedDatabaseIdentity,Pr=/* @__PURE__ */ new Set",
        "count": 1,
        "beforeSha256": "125d7204dc8ee9802e6cbb964ad062a8b2acab32a971d553ca6c9dfd78c9cf1e",
        "afterSha256": "564f2734cae87278eb9d04e48ad3e392e7a638cef8d1d2eb5f679b1560b43c42"
      },
      {
        "name": "move-alias-admission-from-existing-row",
        "before": "let Zt=Kt.filter(Ot=>matchesAgentDatabaseReadCandidatePath({...Ot,path:Ot.physicalPath},wi.source.path));if(Zt.length===0)throw new SessionMutationFactsUnavailableError;for(let Ot of Zt)Pr.add(path.resolve(Ot.path));",
        "after": "",
        "count": 1,
        "beforeSha256": "64c0b51155a1c33a2670570a93a6e5373af260a833c279d3c541e4cc42b1efa9",
        "afterSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      },
      {
        "name": "new-and-existing-row-alias-admission",
        "before": "if(Pr.add(path.resolve(Jn.storePath)),wi&&Pr.add(path.resolve(wi.source.path)),xr){",
        "after": "Pr.add(path.resolve(Jn.storePath));if(wi){Pr.add(path.resolve(wi.source.path));let Zt=Kt.filter(Ot=>matchesAgentDatabaseReadCandidatePath({...Ot,path:Ot.physicalPath},wi.source.path));if(Zt.length===0)throw new SessionMutationFactsUnavailableError;for(let Ot of Zt)Pr.add(path.resolve(Ot.path));selectedDatabaseIdentity=wi.databaseIdentity}if(xr){",
        "count": 1,
        "beforeSha256": "1f22a394a1f00c1bbb97ca35c709af2f5f25e60a7564d07662542b098d0e03fa",
        "afterSha256": "ebc9906e1da6d41379d0ca6327f266b7591c1b324d734ebd997af444ad3e2723"
      },
      {
        "name": "both-publication-identity-arguments",
        "before": "sessionKey:Zt,paths:Pr}",
        "after": "sessionKey:Zt,paths:Pr,databaseIdentity:selectedDatabaseIdentity}",
        "count": 2,
        "beforeSha256": "def726c2142af0dbcc0ae090868d035b77a063a75015fbd025e7d1c361a45b07",
        "afterSha256": "dc452673bb800062ffc2f892671bbd1082b0c6a839ceafda7b439844c14006fa"
      }
    ]
  }
];
export const REVIEWED_INVENTORY = {
  "path": "dist/postinstall-content-inventory.json",
  "inputSha256": "08518e6e02c0d8f315da7829cb6218a681b94da3c21115b9ddb21b7c880b3745",
  "inputBytes": 2036993,
  "outputSha256": "0abcfd15b80b606424ae350dc92e1d58b3f5b23789a29b0eef8c3d7794c055a1",
  "outputBytes": 2036993
};

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };
for (const artifact of REVIEWED_ARTIFACTS) {
  artifact.hunks.forEach(Object.freeze); Object.freeze(artifact.hunks); Object.freeze(artifact);
}
Object.freeze(REVIEWED_ARTIFACTS); Object.freeze(REVIEWED_INVENTORY);
const pins = () => [...REVIEWED_ARTIFACTS, REVIEWED_INVENTORY];
export const MAX_INPUT_BYTES = 256 * 1024 * 1024;

/** Pure byte preparation. No imports of the runtime and no filesystem effects. */
export function backportRuntimeSessionPublication(inputs) {
  requireCondition(inputs instanceof Map && inputs.size === 6 && pins().every(pin => inputs.has(pin.path)),
    'Provide exactly the six reviewed input artifacts.');
  let total = 0;
  for (const pin of pins()) {
    const bytes = inputs.get(pin.path);
    requireCondition(Buffer.isBuffer(bytes) && bytes.length === pin.inputBytes && digest(bytes) === pin.inputSha256,
      `Unreviewed input artifact: ${pin.path}`);
    total += bytes.length;
  }
  requireCondition(total <= MAX_INPUT_BYTES, 'Input allocation exceeds the reviewed bound.');
  const outputs = new Map();
  for (const pin of REVIEWED_ARTIFACTS) {
    let result = inputs.get(pin.path).toString('utf8');
    for (const hunk of pin.hunks) {
      requireCondition(digest(hunk.before) === hunk.beforeSha256 && digest(hunk.after) === hunk.afterSha256,
        'Reviewed section identity changed.');
      requireCondition(result.split(hunk.before).length - 1 === hunk.count,
        `Section count changed: ${pin.path}/${hunk.name}`);
      result = result.split(hunk.before).join(hunk.after);
    }
    const bytes = Buffer.from(result, 'utf8');
    requireCondition(bytes.length === pin.outputBytes && digest(bytes) === pin.outputSha256,
      `Prepared artifact differs from its reviewed output: ${pin.path}`);
    outputs.set(pin.path, bytes);
  }
  const inventory = JSON.parse(inputs.get(REVIEWED_INVENTORY.path).toString('utf8'));
  requireCondition(Array.isArray(inventory), 'Unexpected content inventory schema.');
  for (const pin of REVIEWED_ARTIFACTS) {
    const matches = inventory.filter(row => row.path === pin.path);
    requireCondition(matches.length === 1 && matches[0].sha256 === pin.inputSha256 && matches[0].size === pin.inputBytes,
      `Inventory does not describe the reviewed input: ${pin.path}`);
    matches[0].sha256 = pin.outputSha256;
    matches[0].size = pin.outputBytes;
  }
  const inventoryBytes = Buffer.from(JSON.stringify(inventory, null, 2) + '\n', 'utf8');
  requireCondition(inventoryBytes.length === REVIEWED_INVENTORY.outputBytes
    && digest(inventoryBytes) === REVIEWED_INVENTORY.outputSha256, 'Prepared content inventory differs.');
  outputs.set(REVIEWED_INVENTORY.path, inventoryBytes);
  return outputs;
}

function ordinary(filename, missingLeaf = false) {
  requireCondition(typeof filename === 'string' && path.isAbsolute(filename), 'Use absolute paths.');
  const absolute = path.resolve(filename), root = path.parse(absolute).root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current, { bigint: true, throwIfNoEntry: false });
    if (missingLeaf && index === parts.length - 1) {
      requireCondition(!stat, 'Output already exists.');
      continue;
    }
    requireCondition(stat && !stat.isSymbolicLink(), 'Only ordinary paths are accepted.');
    if (index < parts.length - 1) requireCondition(stat.isDirectory(), 'A path ancestor is not a directory.');
  }
  return absolute;
}
const identity = stat => [stat.dev, stat.ino, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const comparable = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const contains = (parent, child) => {
  const relative = path.relative(comparable(parent), comparable(child));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

/** Emits a new packet only. It cannot overwrite, install, import or start a runtime. */
export function writeBackportedSessionPublication({ source, output }) {
  source = ordinary(source); output = ordinary(output, true);
  requireCondition(fs.lstatSync(source).isDirectory(), 'Source must be an ordinary runtime directory.');
  requireCondition(!contains(source, output) && !contains(output, source), 'Source and output trees must be separate.');
  const inputs = new Map(), captured = [];
  let total = 0;
  for (const pin of pins()) {
    const filename = ordinary(path.join(source, pin.path));
    const before = fs.lstatSync(filename, { bigint: true });
    requireCondition(before.isFile() && before.nlink === 1n && before.size === BigInt(pin.inputBytes)
      && before.size <= 128n * 1024n * 1024n, 'Input must be a reviewed ordinary, singly linked bounded file.');
    total += Number(before.size);
    requireCondition(total <= MAX_INPUT_BYTES, 'Input allocation exceeds the reviewed bound.');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      requireCondition(identity(fs.fstatSync(fd, { bigint: true })) === identity(before), 'Input changed before reading.');
      inputs.set(pin.path, fs.readFileSync(fd));
      requireCondition(identity(fs.fstatSync(fd, { bigint: true })) === identity(before), 'Input changed while reading.');
    } finally { fs.closeSync(fd); }
    captured.push({ filename, identity: identity(before) });
  }
  const recheck = () => { for (const item of captured) {
    ordinary(item.filename);
    requireCondition(identity(fs.lstatSync(item.filename, { bigint: true })) === item.identity, 'Input namespace changed.');
  } };
  const outputs = backportRuntimeSessionPublication(inputs);
  recheck(); ordinary(output, true);
  fs.mkdirSync(output, { mode: 0o700 });
  const outputRootIdentity = identity(fs.lstatSync(output, { bigint: true }));
  for (const [name, bytes] of outputs) {
    const filename = path.join(output, name), parent = path.dirname(filename);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    ordinary(parent); ordinary(filename, true);
    const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    let writtenIdentity;
    try {
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd, { bigint: true });
      requireCondition(stat.isFile() && stat.nlink === 1n && stat.size === BigInt(bytes.length), 'Prepared output identity differs.');
      writtenIdentity = identity(stat);
    } finally { fs.closeSync(fd); }
    ordinary(filename);
    requireCondition(identity(fs.lstatSync(filename, { bigint: true })) === writtenIdentity, 'Prepared output namespace changed.');
    requireCondition(digest(fs.readFileSync(filename)) === digest(bytes), 'Prepared output readback differs.');
  }
  // Directory timestamps legitimately changed while producing children. Preserve native object identity.
  ordinary(output);
  const rootNow = identity(fs.lstatSync(output, { bigint: true })).split(':').slice(0, 2).join(':');
  requireCondition(rootNow === outputRootIdentity.split(':').slice(0, 2).join(':'), 'Output directory was replaced.');
  recheck();
  const receipt = {
    format: 1, status: 'prepared-not-installed', runtimeVersion: REVIEWED_RUNTIME_VERSION, upstreamCommit: UPSTREAM_COMMIT,
    source, output, artifacts: pins().map(({ path, inputSha256, inputBytes, outputSha256, outputBytes }) =>
      ({ path, inputSha256, inputBytes, outputSha256, outputBytes })),
    scriptSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))), inputModified: false, runtimeStarted: false,
    sourceMapping: 'physical-database-identity-with-new-and-existing-row-alias-admission',
    qualification: 'not-established-by-preparation',
  };
  fs.writeFileSync(path.join(output, 'PREPARATION.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    requireCondition(args.length === 4 && args[0] === '--source' && args[2] === '--output',
      'Usage: node backport-runtime-session-publication.mjs --source ABSOLUTE_RUNTIME --output NEW_ABSOLUTE_PACKET');
    process.stdout.write(JSON.stringify(writeBackportedSessionPublication({ source: args[1], output: args[3] })) + '\n');
  } catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
}
