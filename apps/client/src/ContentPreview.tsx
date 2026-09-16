import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type {Content} from '../../../packages/domain/workspace-records';
export default function ContentPreview({value}:{value:Pick<Content,'body'|'format'|'assets'>}){
 return <div className="content-preview">{value.format==='text'?<pre>{value.body||'Your writing will appear here.'}</pre>:<ReactMarkdown remarkPlugins={[remarkGfm,remarkBreaks]} skipHtml components={{
  img:({src,alt})=>{const file=value.assets?.find(f=>src===`/api/attachments/${f.id}`||src===`/api/attachments/${f.id}?preview=1`);return file?<span className="content-inline-image"><img src={`/api/attachments/${file.id}?preview=1`} alt={alt??file.name} loading="lazy"/><span className="content-image-caption">{alt??file.name}</span></span>:<span>{alt||'Image'}{src&&/^https?:\/\//.test(src)?<> · <a href={src} target="_blank" rel="noopener noreferrer">Open image source</a></>:null}</span>;},
  a:({href,children})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  table:({children})=><div className="content-table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"><table>{children}</table></div>,
 }}>{value.body||'Your writing will appear here.'}</ReactMarkdown>}</div>;
}
