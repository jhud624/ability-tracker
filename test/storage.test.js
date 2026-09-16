const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {updateStoreData,readStoreData}=require('../storage');
test('backup failure reports a committed write with warning, without losing primary data',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coach-backup-failure-'));
  const old=process.env.COACH_LOOP_DATA_DIR;
  process.env.COACH_LOOP_DATA_DIR=dir;
  try {
    fs.writeFileSync(path.join(dir,'backups'),'blocking fixture');
    const result=await updateStoreData(()=>({revision:0}),s=>({...s,revision:s.revision+1,preference:'saved'}));
    assert.equal(result.revision,1);
    assert.match(result.storage_warnings[0],/Primary data saved/);
    const current=await readStoreData(()=>({}));
    assert.equal(current.preference,'saved');
    assert.equal(current.storage_warnings,undefined);
  } finally {
    if(old===undefined)delete process.env.COACH_LOOP_DATA_DIR;else process.env.COACH_LOOP_DATA_DIR=old;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
