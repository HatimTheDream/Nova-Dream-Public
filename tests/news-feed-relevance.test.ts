import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyFeedSettings,emptyFeedLearningControl,interpretFeedProfile,deriveFeedInterests,feedEligibility,rankEligibleFeed,resetFeedLearning,
 refreshFeedLearning,nextFeedFeedback,feedSettingsSchema,feedStorySchema,feedEvidenceSchema,feedContainsTopic,type FeedProfile,type FeedStory,type FeedEvidence} from '../packages/domain/news-feed';
const now=Date.parse('2026-10-20T12:00:00Z'),at=new Date(now).toISOString(),control=emptyFeedLearningControl();
const profile=():FeedProfile=>({format:1,revision:3,updatedAt:at,settings:{...emptyFeedSettings(),interests:['prototyping'],sources:[{id:'source:one',title:'Publisher',url:'https://publisher.example/feed.xml',enabled:true}]}});
const story=(patch:Partial<FeedStory>={}):FeedStory=>({id:'a'.repeat(64),revision:1,canonicalUrl:'https://publisher.example/story',sourceId:'source:one',publisherId:'publisher.example',publisher:'Publisher',title:'Practical prototyping',summary:'A publisher-provided preview of prototyping methods.',summaryKind:'publisher-preview',publishedAt:at,updatedAt:null,fetchedAt:at,sourceDigest:'b'.repeat(64),topics:['prototyping'],...patch});
const evidence=(id:string,patch:Partial<FeedEvidence>={}):FeedEvidence=>({id,eventId:'event:'+id,source:'library',sourceId:'item:'+id,sourceRevision:1,contextSha256:'c'.repeat(64),at,action:'save',topic:'interface design',quote:'Prototyping and interface design methods.',available:true,anchorTopics:['prototyping'],...patch});
const learning=()=>{const p=profile();p.settings.learning={enabled:true,paused:false,instructionsOnly:false,allowed:['library','reading','ideas'],scope:'related'};return p;};
test('Feed defaults expose no generic edition and unknown directions never become invented matches',()=>{
 const p=profile();p.settings=emptyFeedSettings();assert.equal(feedEligibility(p,control,story(),[],[],now).eligible,false);
 p.settings=profile().settings;p.settings.directions='Only practical developments that help my current project';
 assert.equal(interpretFeedProfile(p).status,'pending');assert.deepEqual(interpretFeedProfile(p).unsupported,[p.settings.directions]);
 const result=feedEligibility(p,control,story(),[],[],now);assert(!result.eligible&&result.reason==='matching-pending');
});
test('literal direction interpretation preserves exact raw writing and Only overrides broader interests',()=>{
 const p=profile();p.settings.interests=['sports','music'];p.settings.directions='Only topics: interface design; C++\nExclude topics: advertising';
 const raw=structuredClone(p),rules=interpretFeedProfile(p);assert.deepEqual(rules.topics,['interface design','C++']);assert.deepEqual(rules.excluded,['advertising']);assert(rules.only);assert.deepEqual(p,raw);
 assert(feedContainsTopic('A C++ tutorial','C++'));assert(!feedContainsTopic('prototype','proto'));
 p.settings.directions+='\nOnly topics: music';assert.equal(interpretFeedProfile(p).status,'pending');
});
test('Following and thumbs feedback cannot bypass source withdrawal, exclusions or relevance',()=>{
 const p=profile();p.settings.followedPublishers=['publisher.example'];p.settings.exclusions=['advertising'];
 const excluded=story({summary:'Prototyping advertising'}),unrelated=story({id:'d'.repeat(64),title:'Football',summary:'A sporting result',topics:['football']});
 assert.equal(rankEligibleFeed([excluded,unrelated],p,control,[],[],now,{[excluded.id]:'more',[unrelated.id]:'more'},{following:true}).length,0);
 p.settings.exclusions=[];p.settings.sources[0].enabled=false;assert.equal(feedEligibility(p,control,story(),[],[],now).eligible,false);
});
test('relevance records bind exact story and profile revisions and explain only matched terms',()=>{
 const p=profile(),result=feedEligibility(p,control,story(),[],[],now);
 assert(result.eligible);assert.equal(result.profileRevision,3);assert.equal(result.storyRevision,1);assert.deepEqual(result.reasons,[{kind:'written-topic',topic:'prototyping',evidenceIds:[]}]);
 p.revision=4;p.settings.interests=['biology'];assert.equal(feedEligibility(p,control,story(),[],[],now).eligible,false);
});
test('single opens, unavailable sources, repeated identity and duplicate events cannot establish learning',()=>{
 const p=learning();
 for(const rows of [[evidence('a',{action:'open'}),evidence('b',{action:'open'})],[evidence('a')],[evidence('a'),evidence('a')],[evidence('a',{available:false}),evidence('b')],[evidence('a'),evidence('b',{eventId:'event:a'})]])
 assert.deepEqual(deriveFeedInterests(p,control,rows,now),[]);
});
test('actual permitted repeated actions can support a related interest with retrievable exact evidence',()=>{
 const p=learning(),rows=[evidence('a'),evidence('b',{source:'ideas',action:'pursue'})],interests=deriveFeedInterests(p,control,rows,now);
 assert.equal(interests.length,1);assert.equal(interests[0].status,'active');assert.equal(interests[0].evidence.length,2);
 const result=feedEligibility(p,control,story({title:'Interface design',summary:'A useful interface design preview',topics:[]}),interests,rows,now);
 assert(result.eligible);assert.deepEqual(result.reasons[0].evidenceIds,interests[0].evidence.map(r=>r.id));
});
test('within-interest and Only constraints keep unsupported discoveries as suggestions',()=>{
 const p=learning(),rows=[evidence('a'),evidence('b')];p.settings.learning.scope='within';
 assert.equal(deriveFeedInterests(p,control,rows,now)[0].status,'suggested');
 p.settings.learning.scope='related';p.settings.directions='Only topics: prototyping';
 assert.equal(deriveFeedInterests(p,control,rows,now)[0].status,'suggested');
 assert.equal(feedEligibility(p,{...control,kept:['interface design']},story({title:'Interface design',summary:'Interface design',topics:[]}),[],rows,now).eligible,false);
});
test('activity-only setup requires sufficient permitted evidence, never default headlines',()=>{
 const p=learning();p.settings.interests=[];const rows=[evidence('a'),evidence('b')],s=story({title:'Interface design',summary:'Useful interface design',topics:[]});
 assert.equal(feedEligibility(p,control,s,[],rows,now).eligible,false);const interests=deriveFeedInterests(p,control,rows,now);assert.equal(feedEligibility(p,control,s,interests,rows,now).eligible,true);
 assert.equal(feedEligibility(p,control,story({title:'Football',summary:'Football',topics:[]}),interests,rows,now).eligible,false);
});
test('withdrawal, changed evidence and stopped interests immediately invalidate cached learned eligibility',()=>{
 const p=learning(),rows=[evidence('a'),evidence('b')],interests=deriveFeedInterests(p,control,rows,now),s=story({title:'Interface design',summary:'Interface design',topics:[]});
 for(const changed of [rows.map(r=>({...r,available:false})),rows.map(r=>({...r,sourceRevision:2})),rows.map(r=>({...r,contextSha256:'d'.repeat(64)}))])
 assert.equal(feedEligibility(p,control,s,interests,changed,now).eligible,false);
 p.settings.learning.allowed=[];assert.equal(feedEligibility(p,control,s,interests,rows,now).eligible,false);
 p.settings.learning.allowed=['library'];assert.equal(feedEligibility(p,{...control,stopped:['interface design']},s,interests,rows,now).eligible,false);
});
test('Pause freezes automatic updates; Instructions Only stops using learned interests',()=>{
 const p=learning(),rows=[evidence('a'),evidence('b')],interests=deriveFeedInterests(p,control,rows,now),s=story({title:'Interface design',summary:'Interface design',topics:[]});
 p.settings.learning.paused=true;assert.deepEqual(refreshFeedLearning(p,control,interests,[],now),interests);
 assert.equal(feedEligibility(p,control,s,interests,rows,now).eligible,true);
 p.settings.learning.instructionsOnly=true;assert.equal(feedEligibility(p,control,s,interests,rows,now).eligible,false);
});
test('reset pauses learning and clears derived history without changing written rules, controls or permitted sources',()=>{
 const p=learning();p.settings.learning.instructionsOnly=true;const c={...control,stopped:['old topic'],kept:['deliberate interest']};
 const reset=resetFeedLearning(p,c,at);assert.equal(reset.profile.settings.directions,p.settings.directions);assert.deepEqual(reset.profile.settings.interests,p.settings.interests);
 assert(reset.profile.settings.learning.paused);assert(reset.profile.settings.learning.instructionsOnly);assert.deepEqual(reset.profile.settings.learning.allowed,p.settings.learning.allowed);
 assert.deepEqual(reset.control.stopped,c.stopped);assert.deepEqual(reset.control.kept,c.kept);assert.deepEqual(reset.interests,[]);
 assert.deepEqual(deriveFeedInterests(reset.profile,reset.control,[evidence('a'),evidence('b')],now),[]);
});
test('evidence decays; future activity and expired source history cannot manufacture an enduring interest',()=>{
 const p=learning(),old=new Date(now-80*86400000).toISOString();
 assert.deepEqual(deriveFeedInterests(p,control,[evidence('a',{at:old}),evidence('b',{at:old})],now),[]);
 assert.deepEqual(deriveFeedInterests(p,control,[evidence('a',{at:new Date(now+1).toISOString()}),evidence('b')],now),[]);
 const s=story({title:'Interface design',summary:'Interface design',topics:[]});p.settings.learning.allowed=[];
 assert(feedEligibility(p,{...control,kept:['interface design']},s,[],[],now).eligible);
});
test('canonical feedback is reversible and ranking does not mutate the current reading array',()=>{
 assert.equal(nextFeedFeedback('neutral','more'),'more');assert.equal(nextFeedFeedback('more','less'),'less');assert.equal(nextFeedFeedback('less','less'),'neutral');
 const p=profile(),a=story(),b=story({id:'b'.repeat(64)}),rows=[a,b],before=structuredClone(rows);
 const ranked=rankEligibleFeed(rows,p,control,[],[],now,{[a.id]:'less',[b.id]:'more'});assert.equal(ranked[0].story.id,b.id);assert.deepEqual(rows,before);
 assert.equal(rankEligibleFeed(rows,p,control,[],[],now,{}, {hidden:[a.id]}).length,1);assert.equal(rankEligibleFeed(rows,p,control,[],[],now,{}).length,2);
});
test('feed schemas retain bounded source/story/evidence identity and reject extra capabilities',()=>{
 assert(feedSettingsSchema.safeParse(profile().settings).success);assert(feedStorySchema.safeParse(story()).success);assert(feedEvidenceSchema.safeParse(evidence('a')).success);
 assert(!feedSettingsSchema.safeParse({...profile().settings,learning:{...profile().settings.learning,allowed:['private-mail']}}).success);
 assert(!feedSettingsSchema.safeParse({...profile().settings,sources:[{id:'source:a',title:'Secret',url:'https://user:password@example.com/rss',enabled:true}]}).success);
 assert(!feedSettingsSchema.safeParse({...profile().settings,interests:['AI','ai']}).success);
});
test('More and Less shape future related eligible stories while paused, without admitting unrelated stories',()=>{
 const p=profile();p.settings.learning.paused=true;
 const a=story({id:'a'.repeat(64),title:'Prototyping interfaces',summary:'Interface design and prototyping',topics:['interface design']});
 const b=story({id:'b'.repeat(64),title:'Prototyping furniture',summary:'Prototyping objects',topics:['furniture']});
 const unrelated=story({id:'c'.repeat(64),title:'Interface design',summary:'Interface design',topics:[]});
 const feedback:Record<string,{value:'more'|'less';topics:string[]}>={['0'.repeat(64)]:{value:'more',topics:['interface design']}};
 assert.equal(rankEligibleFeed([b,a,unrelated],p,control,[],[],now,feedback)[0].story.id,a.id);
 assert.equal(rankEligibleFeed([b,a,unrelated],p,control,[],[],now,feedback).length,2);
 feedback['0'.repeat(64)]={value:'less',topics:['interface design']};
 assert.equal(rankEligibleFeed([a,b],p,control,[],[],now,feedback)[0].story.id,b.id);
 assert.deepEqual(p.settings.interests,['prototyping']);
});
