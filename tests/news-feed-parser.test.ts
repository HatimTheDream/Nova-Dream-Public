import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNewsFeed,canonicalNewsUrl,newsDigest,NEWS_FEED_BYTES} from '../apps/service/news-feed-parser';
const source={id:'source:test',title:'Test Publisher',url:'https://publisher.example/feed.xml',enabled:true},at='2026-10-20T12:00:00Z';
const parse=(raw:string)=>parseNewsFeed(source,Buffer.from(raw),at);
test('RSS retains attributable publisher previews, exact source digest and canonical original identity',()=>{
 const raw='<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>Ignored remote label</title><item><title>Design &amp; Research</title><link>/article#section</link><pubDate>Tue, 20 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Full publisher preview.</p><script>steal()</script>]]></description><category>Interface design</category></item></channel></rss>';
 const result=parse(raw),story=result.stories[0];assert.equal(result.rejected.length,0);assert.equal(story.title,'Design & Research');assert.equal(story.publisher,source.title);
 assert.equal(story.canonicalUrl,'https://publisher.example/article');assert.equal(story.summary,'Full publisher preview.');assert.equal(story.summaryKind,'publisher-preview');
 assert.equal(story.sourceDigest,newsDigest(Buffer.from(raw)));assert.equal(story.publishedAt,'2026-10-20T10:00:00.000Z');assert.deepEqual(story.topics,['Interface design']);
});
test('Atom alternate links and self-closing categories retain UTF-8 text and publication/update timestamps',()=>{
 const result=parse('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Writing 🐈</title><link rel="self" href="/api/item"/><link rel="alternate" href="/story"/><summary>Complete short preview</summary><published>2026-10-19T10:00:00Z</published><updated>2026-10-20T10:00:00Z</updated><category term="Writing"/></entry></feed>');
 assert.equal(result.stories.length,1);assert.equal(result.stories[0].canonicalUrl,'https://publisher.example/story');assert.equal(result.stories[0].title,'Writing 🐈');
 assert.equal(result.stories[0].updatedAt,'2026-10-20T10:00:00.000Z');assert.deepEqual(result.stories[0].topics,['Writing']);
});
test('JSON Feed supports publisher text/HTML previews and explicitly labels URL-only entries',()=>{
 const result=parse(JSON.stringify({version:'https://jsonfeed.org/version/1.1',items:[{id:'a',title:'A',url:'https://publisher.example/a',content_html:'<b>Provided</b> preview'},{id:'b',title:'B',url:'https://publisher.example/b'}]}));
 assert.equal(result.stories[0].summary,'Provided preview');assert.equal(result.stories[1].summaryKind,'url-only');assert.equal(result.stories[1].summary,'');
});
test('publisher text fields preserve literal markup characters instead of reinterpreting them as HTML',()=>{
 const text='Use <chapter> for structure, with x < y and y > z.';
 const json=parse(JSON.stringify({version:'https://jsonfeed.org/version/1',items:[{title:'The <chapter> Tag',url:'https://publisher.example/text',content_text:text}]})).stories[0];
 assert.equal(json.title,'The <chapter> Tag');assert.equal(json.summary,text);
 const atom=parse('<feed><entry><title>Text</title><link href="/text"/><summary>Keep &lt;chapter&gt; here.</summary></entry></feed>').stories[0];
 assert.equal(atom.summary,'Keep <chapter> here.');
 const html=parse('<feed><entry><title>HTML</title><link href="/html"/><summary type="html">&lt;b&gt;Bold&lt;/b&gt; preview</summary></entry></feed>').stories[0];
 assert.equal(html.summary,'Bold preview');
});
test('unsafe/missing originals and oversized entries have visible rejection counts without silently truncating',()=>{
 const result=parse(JSON.stringify({version:'https://jsonfeed.org/version/1',items:[{title:'Unsafe',url:'javascript:alert(1)'},{title:'Large',url:'https://publisher.example/large',content_text:'x'.repeat(6001)},{title:'Missing'}]}));
 assert.equal(result.stories.length,0);assert.equal(result.rejected.length,3);assert.match(result.rejected[1].reason,/too long/);
});
test('canonical deduplication never merges resource-significant queries or invents a remote canonical link',()=>{
 const result=parse('<rss><channel><item><title>First</title><link>https://publisher.example/a#one</link></item><item><title>Duplicate</title><link>https://publisher.example/a#two</link></item><item><title>Another</title><link>https://publisher.example/a?id=2</link></item></channel></rss>');
 assert.equal(result.stories.length,2);assert.equal(result.stories[0].title,'First');assert.notEqual(result.stories[0].id,result.stories[1].id);
 assert.equal(canonicalNewsUrl('https://user:password@publisher.example/private'),undefined);assert.equal(canonicalNewsUrl('file:///private'),undefined);
});
test('effective feed redirect URL resolves relative links while configured publisher identity remains stable',()=>{
 const result=parseNewsFeed(source,Buffer.from('<feed><entry><title>Moved feed</title><link href="story"/></entry></feed>'),at,'https://cdn.example/path/feed.xml');
 assert.equal(result.stories[0].canonicalUrl,'https://cdn.example/path/story');assert.equal(result.stories[0].publisherId,'publisher.example');
});
test('bounded parser rejects declarations, unsupported encodings, excessive structures and unfinished documents',()=>{
 for(const raw of ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///private">]><rss/>','<?xml version="1.0" encoding="ISO-8859-1"?><rss/>','<html><body>Not a feed</body></html>','<rss><channel>','<rss>'+('<n>'.repeat(33))+'</n>'.repeat(33)+'</rss>','<rss/><rss/>'])
 assert.throws(()=>parse(raw));
 assert.throws(()=>parseNewsFeed(source,new Uint8Array(NEWS_FEED_BYTES+1),at),/2 MB/);
 assert.throws(()=>parseNewsFeed(source,Uint8Array.from([0xff,0xfe]),at));
 assert.throws(()=>parse(JSON.stringify({version:'https://jsonfeed.org/version/1',items:Array.from({length:201},()=>({}))})),/200/);
});
test('only direct entry metadata is used; nested media titles cannot replace an article title',()=>{
 const result=parse('<rss><channel><item><title>Actual article</title><link>/actual</link><media:group><media:title>Misleading nested title</media:title></media:group></item></channel></rss>');
 assert.equal(result.stories[0].title,'Actual article');
});
