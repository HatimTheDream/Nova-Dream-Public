import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {Parser} from 'htmlparser2';
import {publicNetworkHostname} from './public-network-address.js';
import {feedSourceSchema,feedSourceUrl,feedStorySchema,type FeedSource,type FeedStory} from '../../packages/domain/news-feed.js';

export const NEWS_FEED_BYTES=2*1024*1024;
export const NEWS_FEED_ITEMS=200;
export const newsDigest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** Preserve resource-significant query parameters. Normalize URL syntax and
 * remove only the document fragment; do not guess canonical links from HTML. */
export function canonicalNewsUrl(raw:string,base?:string){
 try{const url=new URL(raw,base);url.hash='';return publicNetworkHostname(url.hostname)?feedSourceUrl(url.href):undefined;}catch{return;}
}
function plain(raw:string,maximum:number){
 let result='',hidden=0,nodes=0;
 const parser=new Parser({
  onopentag(name){if(++nodes>10000)throw Error('Preview markup exceeds its supported size.');if(['script','style','iframe','object','svg'].includes(name))hidden++;if(!hidden)result+=' ';},
  onclosetag(name){if(['script','style','iframe','object','svg'].includes(name)&&hidden)hidden--;if(!hidden)result+=' ';},
  ontext(text){if(!hidden){result+=text;if(result.length>maximum*4)throw Error('Publisher preview is too long.');}},
 },{decodeEntities:true});
 parser.end(raw);
 result=result.replace(/\s+/gu,' ').trim();
 if(result.length>maximum)throw Error('Publisher preview is too long.');
 return result;
}
const date=(raw:unknown)=>{if(typeof raw!=='string'||raw.length>100)return null;const at=Date.parse(raw);return Number.isFinite(at)?new Date(at).toISOString():null;};
const literal=(raw:string,maximum:number)=>{const value=raw.replace(/\s+/gu,' ').trim();if(value.length>maximum)throw Error('Publisher preview is too long.');return value;};
type Entry={title?:unknown;url?:unknown;summary?:unknown;summaryIsHtml?:boolean;published?:unknown;updated?:unknown;tags?:unknown};
export type ParsedNewsFeed={sourceId:string;sourceDigest:string;fetchedAt:string;stories:FeedStory[];rejected:{index:number;reason:string}[]};
function jsonEntries(raw:string):Entry[]{
 const feed=JSON.parse(raw);
 if(!feed||!['https://jsonfeed.org/version/1','https://jsonfeed.org/version/1.1'].includes(feed.version)||!Array.isArray(feed.items)||feed.items.length>NEWS_FEED_ITEMS)
  throw Error('Use a supported JSON Feed with at most 200 entries.');
 return feed.items.map((item:Record<string,unknown>)=>({title:item?.title,url:item?.url??item?.external_url,summary:item?.summary??item?.content_text??item?.content_html,
  summaryIsHtml:item?.summary==null&&item?.content_text==null,published:item?.date_published,updated:item?.date_modified,tags:item?.tags}));
}
function xmlEntries(raw:string):Entry[]{
 if(/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(raw))throw Error('Feed declarations and external entities are unsupported.');
 const encoding=/^<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/iu.exec(raw.trimStart());
 if(encoding&&!/^utf-?8$/iu.test(encoding[1]))throw Error('This feed must provide UTF-8 text.');
 const entries:Entry[]=[],path:string[]=[];let roots=0,nodes=0,current:{depth:number;fields:Map<string,string[]>;htmlFields:Set<string>;link?:string;tags:string[]}|undefined;
 let field:{name:string;depth:number;text:string}|undefined;
 const parser=new Parser({
  onopentag(name,attrs){
   if(++nodes>10000||path.length>=32)throw Error('Feed structure exceeds its supported bounds.');
   name=name.toLowerCase();path.push(name);
   if(path.length===1){if(++roots>1||!['rss','rdf:rdf','feed'].includes(name))throw Error('Use an RSS, Atom or JSON feed.');}
   const item=path[0]==='feed'&&path.length===2&&name==='entry'
    ||path[0]==='rss'&&path.length===3&&path[1]==='channel'&&name==='item'
    ||path[0]==='rdf:rdf'&&path.length===2&&name==='item';
   if(item){if(entries.length>=NEWS_FEED_ITEMS)throw Error('The feed exceeds 200 entries.');current={depth:path.length,fields:new Map(),htmlFields:new Set(),tags:[]};}
   else if(current&&path.length===current.depth+1){
    if(name==='link'&&attrs.href&&(!attrs.rel||attrs.rel==='alternate')&&!current.link)current.link=attrs.href;
    if(name==='category'&&attrs.term)current.tags.push(attrs.term);
    if(path[0]!=='feed'||attrs.type==='html'||attrs.type==='xhtml')current.htmlFields.add(name);
    field={name,depth:path.length,text:''};
   }
   else if(field&&!['script','style'].includes(name))field.text+=' ';
  },
  ontext(text){if(field&&!path.some(name=>['script','style'].includes(name))){field.text+=text;if(field.text.length>80000)throw Error('An entry exceeds the supported preview size.');}},
  onclosetag(name,implied){
   const selfClosing=raw.slice(parser.startIndex,parser.endIndex+1).trimEnd().endsWith('/>');
   if(implied&&!selfClosing)throw Error('The feed has an unfinished or mismatched element.');
   if(field&&path.length===field.depth){const rows=current!.fields.get(field.name)??[];if(rows.length>=32)throw Error('An entry repeats too many fields.');rows.push(field.text);current!.fields.set(field.name,rows);field=undefined;}
   if(current&&path.length===current.depth){
    const first=(...names:string[])=>names.map(key=>current!.fields.get(key)?.[0]).find(value=>value?.trim());
    const summaryName=['summary','description','content:encoded','content'].find(name=>current!.fields.get(name)?.[0]?.trim());
    entries.push({title:first('title'),url:current.link??first('link','guid'),summary:summaryName?first(summaryName):undefined,summaryIsHtml:!!summaryName&&current.htmlFields.has(summaryName),
     published:first('published','pubdate','dc:date'),updated:first('updated'),tags:[...current.tags,...(current.fields.get('category')??[])]});
    current=undefined;
   }
   if(path.at(-1)!==name.toLowerCase())throw Error('The feed element identity changed.');
   path.pop();
  },
 },{xmlMode:true,decodeEntities:true,lowerCaseAttributeNames:true});
 parser.end(raw);if(!roots||path.length)throw Error('The feed is incomplete.');
 return entries;
}
/** Extract publisher-provided previews only. No article fetch, HTML execution,
 * image loading, semantic interpretation or implicit Library save occurs. */
export function parseNewsFeed(source:FeedSource,bytes:Uint8Array,fetchedAt:string,effectiveUrl=source.url):ParsedNewsFeed{
 feedSourceSchema.parse(source);
 if(!bytes.length||bytes.length>NEWS_FEED_BYTES)throw Error('The source exceeds the 2 MB feed limit.');
 if(!canonicalNewsUrl(source.url)||!canonicalNewsUrl(effectiveUrl)||!Number.isFinite(Date.parse(fetchedAt)))throw Error('The feed source identity is invalid.');
 let raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);raw=raw.replace(/^\uFEFF/u,'');
 const entries=raw.trimStart().startsWith('{')?jsonEntries(raw):xmlEntries(raw),digest=newsDigest(bytes);
 const result:ParsedNewsFeed={sourceId:source.id,sourceDigest:digest,fetchedAt:new Date(fetchedAt).toISOString(),stories:[],rejected:[]},seen=new Set<string>();
 for(const [index,entry]of entries.entries()){
  try{
   if(typeof entry.title!=='string'||typeof entry.url!=='string')throw Error('This entry has no usable title and original link.');
   const url=canonicalNewsUrl(entry.url,effectiveUrl);if(!url)throw Error('The original link is unsupported.');
   const title=literal(entry.title,500);if(!title)throw Error('The entry title is empty.');
   const summary=typeof entry.summary==='string'?(entry.summaryIsHtml?plain:literal)(entry.summary,6000):'';
   const tags=Array.isArray(entry.tags)?entry.tags.filter((tag):tag is string=>typeof tag==='string').map(tag=>literal(tag,80)).filter(Boolean):[];
   const topics=[...new Map(tags.map(tag=>[tag.normalize('NFKC').toLowerCase(),tag])).values()];
   const story=feedStorySchema.parse({id:newsDigest(url),revision:1,canonicalUrl:url,sourceId:source.id,publisherId:new URL(source.url).hostname,
    publisher:source.title,title,summary,summaryKind:summary?'publisher-preview':'url-only',publishedAt:date(entry.published),updatedAt:date(entry.updated),
    fetchedAt:result.fetchedAt,sourceDigest:digest,topics});
   if(seen.has(story.id))continue;seen.add(story.id);result.stories.push(story);
  }catch(error){result.rejected.push({index,reason:error instanceof Error?error.message:'This entry is unsupported.'});}
 }
 return result;
}
