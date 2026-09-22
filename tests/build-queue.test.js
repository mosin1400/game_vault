const assert=require('node:assert/strict');
const {createQueue}=require('../backend/builds/queue');
(async()=>{const jobs=[],events=[];const queue=createQueue({next:async()=>jobs.shift()||null,run:async job=>events.push('ran:'+job.id)});await queue.runNext();assert.deepEqual(events,[]);jobs.push({id:'job-1'},{id:'job-2'});await queue.runNext();assert.deepEqual(events,['ran:job-1','ran:job-2']);console.log('build queue contract passed')})().catch(error=>{console.error(error);process.exit(1)});
