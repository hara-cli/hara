// A bounded ICU MessageFormat subset: arguments, select, plural/selectordinal, number/date/time.
// Compile during generation; no parser or translation conversion ships in the runtime.
export function compileMessage(source) {
 let cursor=0,depth=0; const params=new Set();
 const whitespace=()=>{while(/\s/u.test(source[cursor]??'') && cursor<source.length)cursor++;};
 const until=chars=>{const begin=cursor;while(cursor<source.length&&!chars.includes(source[cursor]))cursor++;return source.slice(begin,cursor).trim();};
 function parts(nested=false,plural=false){
  if(++depth>12)throw Error('Message nesting limit');const result=[];let text='';
  const flush=()=>{if(text){result.push(['text',text]);text='';}};
  while(cursor<source.length){
   const char=source[cursor++];
   if(char==="'"){
    if(source[cursor]==="'"){text+="'";cursor++;continue;}
    if(['{','}','#'].includes(source[cursor])){let closed=false;while(cursor<source.length){const q=source[cursor++];if(q==="'"){if(source[cursor]==="'"){text+="'";cursor++;}else{closed=true;break;}}else text+=q;}if(!closed)throw Error('Unclosed ICU quote');continue;}
   }
   if(char==='}') {if(!nested)throw Error('Unmatched ICU brace');flush();depth--;return result;}
   if(char==='#'&&plural){flush();result.push(['pound']);continue;}
   if(char!=='{'){text+=char;continue;}
   flush();whitespace();const name=until([',','}']);if(!/^[A-Za-z_]\w*$/.test(name))throw Error('Invalid ICU argument');params.add(name);
   if(source[cursor]==='}'){cursor++;result.push(['arg',name]);continue;}
   if(source[cursor++]!==',')throw Error('Invalid ICU argument');whitespace();const kind=until([',','}']);
   if(['number','date','time'].includes(kind)){let style='';if(source[cursor]===','){cursor++;style=until(['}']);}if(source[cursor++]!=='}')throw Error('Invalid ICU format');if(style&&!['integer','short','medium','long','full'].includes(style))throw Error('Unsupported ICU format style');result.push([kind,name,style]);continue;}
   if(!['plural','select','selectordinal'].includes(kind)||source[cursor++]!==',')throw Error('Unsupported ICU argument');
   const choices={};whitespace();while(cursor<source.length&&source[cursor]!=='}'){
    const option=until(['{']);if(!/^(?:=\d+|[A-Za-z]+)$/.test(option)||Object.hasOwn(choices,option)||source[cursor++]!=='{')throw Error('Invalid ICU choice');
    choices[option]=parts(true,kind!=='select');whitespace();
   }
   if(source[cursor++]!=='}'||!Object.hasOwn(choices,'other'))throw Error('ICU choices require other');result.push([kind,name,choices]);
  }
  if(nested)throw Error('Unclosed ICU argument');flush();depth--;return result;
 }
 if(typeof source!=='string'||source.length>10000)throw Error('Invalid message');
 const ast=parts();return{ast,params:[...params].sort()};
}
