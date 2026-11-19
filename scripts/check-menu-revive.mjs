import assert from 'node:assert/strict';
import {createServer} from 'vite';
import * as THREE from 'three';
const server=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
  globalThis.addEventListener=()=>{};globalThis.document={addEventListener(){},pointerLockElement:null};
  const {Player}=await server.ssrLoadModule('/src/player.ts');
  const {Faora}=await server.ssrLoadModule('/src/faora.ts');
  const {PersistenceMode}=await server.ssrLoadModule('/src/revival.ts');
  const world={spans:()=>({top:0,floor:()=>0,ceil:()=>Infinity,solid:()=>false}),materialAt:()=>({bounce:0}),crater(){},launch(){}};
  const player=new Player({},{});player.floorAt=()=>0;
  const fighters=['Faora-Ul','Anissa','Battle Beast','Doomsday','Sukuna','Satoru Gojo'].map(name=>new Faora(world,new THREE.Scene(),name));
  for(const unit of [player,...fighters]){
    if(unit instanceof Faora){unit.spawn(4,5);unit.setEnemyMode(true);}
    const maxHealth = unit.name === 'Sukuna' || unit.name === 'Satoru Gojo' ? 600 : 100;
    assert.equal(unit.vitals.health,maxHealth,'fighters spawn with full health');
    unit.vitals.health=0;assert(unit.revive());assert.equal(unit.vitals.health,maxHealth * .4);
    unit.vitals.health=0;assert(unit.revive(true));assert.equal(unit.vitals.health,maxHealth * .75);
    assert.equal(unit.vitals.orientation,75,'revive orientation uses the recovered fraction');
    unit.vitals.health=0;unit.vitals.revivesUsed=3;unit.vel.set(10,-20,30);
    assert.equal(unit.revive(),false,'normal revive cannot bypass final defeat');
    assert.equal(unit.revive(false,true),true,'menu can revive everyone after final defeat');
    assert.equal(unit.vitals.health,maxHealth);assert.equal(unit.vitals.revivesUsed,3,'menu preserves team revival budget');
    assert.equal(unit.vel.length(),0);assert.equal(unit.vitals.defeated,false);
    if(unit instanceof Faora)assert.equal(unit.enemyMode,true,'preserves side');
    unit.vitals.health=15;assert.equal(unit.revive(false,true),false,'cannot heal a living character');assert.equal(unit.vitals.health,15);
    unit.vitals.health=0;unit.vitals.revivesUsed=1;assert(unit.revive(false,true));assert.equal(unit.vitals.revivesUsed,1);
  }
  const mode=new PersistenceMode();mode.setEnabled(true);
  const units=['YOU','Anissa'].map(id=>({id,enemy:false,vitals:{defeated:true}}));mode.update(10,units);
  assert.equal(mode.remainingFor('YOU'),15);mode.forget('YOU');assert.equal(mode.remainingFor('YOU'),25);
  assert.equal(mode.remainingFor('Anissa'),15,'reviving one unit preserves another return countdown');
  console.log('Menu revive: player and every fighter, final defeats, max HP, side/budget preservation, alive guard and per-unit timer cleanup passed.');
}finally{await server.close();}
