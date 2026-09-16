/** Linear validation also handles the largest supported file without the
 * regular-expression recursion caused by repeating four-character groups. */
export function isMailBase64(value:string):boolean {
  if(value.length>13981016||value.length%4!==0)return false;
  const padding=value.endsWith('==')?2:value.endsWith('=')?1:0;
  return !/[^A-Za-z0-9+/]/.test(padding?value.slice(0,-padding):value);
}
