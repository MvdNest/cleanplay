// Local UI-only fixture. Never serves mock playback in production or calls Spotify.
// Run: node tests/preview-server.mjs, then http://127.0.0.1:8765/preview
import http from 'node:http';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const fixtures = `
const sampleTracks=['The Quiet Hours','Somewhere, Slowly','A Different Kind of Morning','The Long Way Home','Everything in Its Own Time','Still Here'].map((name,i)=>({type:'track',id:'Demo'+i,uri:'spotify:track:Demo'+i,name,duration_ms:214000+i*2000,artists:[{id:'Artist1',uri:'spotify:artist:Artist1',name:'The Slow Notes'}],album:{id:'Album1',uri:'spotify:album:Album1',name:'Room to Breathe',release_date:'2025-01-01'},explicit:false}));
let demoIndex=0,demoPlaying=true;
const demoDevice={id:'preview-device',name:'This browser',type:'Computer',volume_percent:65,supports_volume:true};
loadSpotifySdk=async()=>true;registerServiceWorker=()=>{};setupMediaSession=()=>{};
resumeSession=async()=>true;startPolling=()=>{};startProgressTick=()=>{};
function demoPaint(){Object.assign(state,{currentTrack:sampleTracks[demoIndex],currentTrackUri:sampleTracks[demoIndex].uri,currentTrackId:sampleTracks[demoIndex].id,isPlaying:demoPlaying,localProgress:67000,localDuration:sampleTracks[demoIndex].duration_ms});updateNowPlaying({item:state.currentTrack,device:demoDevice});updateControls();}
api=async(path,method,body)=>{
 if(method==='PUT'||method==='POST'){if(path.includes('/pause'))demoPlaying=false;else if(path.includes('/next'))demoIndex=(demoIndex+1)%sampleTracks.length;else if(path.includes('/play')){demoPlaying=true;if(body?.uris){const index=sampleTracks.findIndex(t=>t.uri===body.uris[0]);if(index>=0)demoIndex=index;}}demoPaint();return {};}
 if(path.includes('/search'))return {tracks:{items:sampleTracks},albums:{items:[sampleTracks[0].album]},artists:{items:sampleTracks[0].artists},playlists:{items:[]}};
 if(path.includes('/albums/'))return {...sampleTracks[0].album,total_tracks:6,artists:sampleTracks[0].artists,tracks:{items:sampleTracks}};
 if(path.includes('/queue'))return {currently_playing:sampleTracks[demoIndex],queue:sampleTracks.slice(1)};
 if(path.includes('/devices'))return {devices:[demoDevice]};
 if(path==='/me/player')return {item:sampleTracks[demoIndex],device:demoDevice,is_playing:demoPlaying,shuffle_state:false,repeat_state:'off',progress_ms:67000};
 return {items:[]};
};
decideNextScreen=async()=>{
 Object.assign(state,{accessToken:'preview-only',user:{display_name:'Preview account'},preferredTarget:{kind:'remote'},activeDeviceId:demoDevice.id,activeDeviceName:demoDevice.name});
 document.getElementById('setup').style.display='none';document.getElementById('app').classList.add('active');
 setConnectionHealth('online','Connected','Local UI preview — no Spotify requests.');demoPaint();switchView('now-playing');
 document.getElementById('settings-account').textContent='Local preview';
};
`;
const assets = new Map([['/app.css','app.css'],['/library-backup.js','library-backup.js'],['/manifest.webmanifest','manifest.webmanifest']]);
http.createServer((request,response)=>{
 const path=new URL(request.url,'http://127.0.0.1').pathname;
 response.setHeader('Cache-Control','no-store');
 if(path==='/preview'){
  let html=readFileSync(new URL('index.html',root),'utf8').replace(/<script id="cleanplay-spotify-sdk"[^>]*><\/script>/,'');
  html=html.replace('</body>','<script>'+fixtures+'</script></body>');
  response.setHeader('Content-Type','text/html; charset=utf-8');response.end(html);return;
 }
 if(assets.has(path)){response.setHeader('Content-Type',path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'application/json');response.end(readFileSync(new URL(assets.get(path),root)));return;}
 response.writeHead(404);response.end('Not found');
}).listen(8765,'127.0.0.1',()=>console.log('UI-only preview: http://127.0.0.1:8765/preview'));
