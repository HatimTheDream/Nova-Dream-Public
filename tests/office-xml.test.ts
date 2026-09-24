import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeReadError, text, xml } from '../apps/service/office-archive.js';

test('Office XML accepts legal text, comments, CDATA, processing instructions and empty elements', () => {
  const document = xml(Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<?app permitted?><root attr="&quot;&#65;&#x1F600;">Start<!-- <!DOCTYPE is literal comment text -->&amp;<![CDATA[ &unknown; <literal> ]]><child empty=""/>End</root><?after?>'));
  assert.equal(document.attrs.attr, '"A😀');
  assert.equal(text(document), 'Start& &unknown; <literal> End');
});

test('Office XML rejects malformed raw tokens before tolerant parsing can recover them', () => {
  for (const value of [
    '<root><child/></unexpected></root>', '<root><child></root></child>', '<root/>extra', '<root/><other/>',
    '<root attr=unquoted/>', '<root attr="one" attr="two"/>', '<root a="1"b="2"/>', '<root a="<"/>',
    '<root>&unknown;</root>', '<root a="&unknown;"/>', '<root>&amp</root>', '<root>&</root>',
    '<root>&#0;</root>', '<root>&#xB;</root>', '<root>&#xD800;</root>', '<root>&#65535;</root>', '<root>&#x110000;</root>',
    '<root>&#x;</root>', '<root>&#X41;</root>', '<root>&#-1;</root>', '<root>\ufffe</root>',
    '<root><!--bad--comment--></root>', '<root><!--bad---></root>', '<root><![CDATA[unterminated</root>',
    '<root>]]></root>', '<![CDATA[text]]><root/>', '<root/>tail', '<1invalid/>', '<root / >',
    '<?xml version="1.0"?><root/><?xml version="1.0"?>', ' <?xml version="1.0"?><root/>', '<?XML version="1.0"?><root/>',
    '<?xml encoding="UTF-8"?><root/>', '<?xml version="1.1"?><root/>', '<root><?bad!?></root>', '<root></root',
  ]) assert.throws(() => xml(Buffer.from(value)), (error: unknown) => error instanceof OfficeReadError && error.code === 'office_corrupt', value);
});

test('Office XML permits only built-in references and valid XML character references', () => {
  assert.equal(text(xml(Buffer.from('<root>&lt;&gt;&apos;&quot;&amp;&#9;&#10;&#13;&#32;&#xD7FF;&#xE000;&#xFFFD;&#x10000;&#x10FFFF;</root>'))), '<>\'"&\t\n\r \ud7ff\ue000\ufffd\ud800\udc00\udbff\udfff');
  for (const value of ['<!DOCTYPE root><root/>', '<!DOCTYPE root [<!ENTITY unsafe "expanded">]><root>&unsafe;</root>']) {
    assert.throws(() => xml(Buffer.from(value)), (error: unknown) => error instanceof OfficeReadError && error.code === 'office_unsafe');
  }
});

test('Office XML reads UTF-16 in both byte orders and rejects mismatched or damaged encodings', () => {
  const value = '<?xml version="1.0" encoding="UTF-16"?><root>日本語 😀 &amp; text</root>';
  const littleEndian = Buffer.from(value, 'utf16le'), bigEndian = Buffer.from(littleEndian).swap16();
  for (const bytes of [Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]), Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]), littleEndian, bigEndian]) {
    assert.equal(text(xml(bytes)), '日本語 😀 & text');
  }
  assert.equal(text(xml(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<root>Text</root>', 'utf16le')]))), 'Text');
  for (const bytes of [Buffer.from(value), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<root/>', 'utf16le'), Buffer.from([1])]), Buffer.from([0xff, 0xfe, 0, 0xd8])]) {
    assert.throws(() => xml(bytes), (error: unknown) => error instanceof OfficeReadError && error.code === 'office_corrupt');
  }
});
