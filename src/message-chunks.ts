// Prefer complete paragraphs and lines while respecting platform limits.
export function splitMessage(text:string,size=1900):string[] {
  const chunks:string[]=[];
  while(text.length>size){
    let cut=text.lastIndexOf('\n\n',size);
    if(cut<size/2)cut=text.lastIndexOf('\n',size);
    if(cut<size/2)cut=text.lastIndexOf(' ',size);
    if(cut<size/2)cut=size;
    // Keep a section heading with its first paragraph or list item.
    const prefix=text.slice(0,cut),heading=prefix.match(/(?:^|\n\n)(\*\*[^\n]+\*\*|#{1,6} [^\n]+)$/);
    if(heading&&heading.index!>size/2)cut=heading.index!;
    if(/[\uD800-\uDBFF]/.test(text[cut-1])&&/[\uDC00-\uDFFF]/.test(text[cut]))cut--;
    chunks.push(text.slice(0,cut));text=text.slice(cut).replace(/^\s+/, '');
  }
  if(text)chunks.push(text);return chunks;
}
