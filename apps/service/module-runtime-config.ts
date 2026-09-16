import { z } from 'zod';
import { modulePluginId } from '../../packages/domain/module-actions.js';
export function withModulePlugin(raw:unknown,epoch:string,bundlePath:string,bridge:{url:string;token:string}){
 const config=z.object({plugins:z.object({enabled:z.boolean().optional(),allow:z.array(z.string()).optional(),load:z.object({paths:z.array(z.string()).optional()}).passthrough().optional(),entries:z.record(z.string(),z.any()).optional()}).passthrough().optional()}).passthrough().parse(raw),p=config.plugins??{},prior=p.entries?.[modulePluginId];
 if(p.enabled===false||prior?.enabled===false)return config;
 // Finite agent tool policies disable native Code Mode/tool search. The two
 // workspace tools must be directly discoverable in that restricted surface.
 const codex=p.entries?.codex??{},codexConfig=codex.config??{};
 return {...config,plugins:{...p,enabled:true,allow:[...new Set([...(p.allow??[]),modulePluginId])],load:{...p.load,paths:[...new Set([...(p.load?.paths??[]).filter(path=>path!==prior?.config?.bundlePath),bundlePath])]},entries:{...p.entries,codex:{...codex,config:{...codexConfig,codexDynamicToolsLoading:codexConfig.codexDynamicToolsLoading??'direct'}},[modulePluginId]:{enabled:true,config:{epoch,bundlePath,...bridge}}}}};
}
