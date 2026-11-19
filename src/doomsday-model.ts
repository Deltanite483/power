import * as THREE from 'three';
import type {DoomsdayRig} from './doomsday-rig';
import {addRimLight} from './fighter-mesh';

type Ring = [height: number, width: number, depth: number, centerZ?: number];

function hideTexture() {
  const size=128, data=new Uint8Array(size*size*4);
  const hash=(x:number,y:number)=>((Math.imul(x+13,374761393)^Math.imul(y+17,668265263))>>>0)%1021/1020;
  function sample(x:number,y:number,frequency:number) {
    const u=x*frequency/size, v=y*frequency/size, a=Math.floor(u), b=Math.floor(v);
    const nextX=(a+1)%frequency, nextY=(b+1)%frequency;
    const sx=THREE.MathUtils.smoothstep(u-a,0,1), sy=THREE.MathUtils.smoothstep(v-b,0,1);
    const top=THREE.MathUtils.lerp(hash(a,b),hash(nextX,b),sx);
    const bottom=THREE.MathUtils.lerp(hash(a,nextY),hash(nextX,nextY),sx);
    return THREE.MathUtils.lerp(top,bottom,sy);
  }
  for(let y=0;y<size;y++){
    for(let x=0;x<size;x++){
      const shade=195+sample(x,y,8)*28+sample(x,y,32)*18+hash(x,y)*14;
      const i=(y*size+x)*4;
      data[i]=data[i+1]=data[i+2]=shade;
      data[i+3]=255;
    }
  }
  const texture=new THREE.DataTexture(data,size,size);
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
  texture.magFilter=THREE.LinearFilter;
  texture.minFilter=THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps=true;
  texture.needsUpdate=true;
  return texture;
}

export function buildDoomsday(rig: DoomsdayRig) {
  const grain=hideTexture();
  const skin = new THREE.MeshStandardMaterial({color:0x74796d,roughness:.87,map:grain,bumpMap:grain,bumpScale:.045});
  const hide = new THREE.MeshStandardMaterial({color:0x50554b,roughness:.96,map:grain,bumpMap:grain,bumpScale:.036});
  const bone = new THREE.MeshStandardMaterial({color:0xc9b99b,roughness:.78,flatShading:true,map:grain});
  // A cool edge light keeps his grey hide from sinking into rock and smoke.
  for(const material of [skin,hide,bone])addRimLight(material,.34);
  const mouth = new THREE.MeshStandardMaterial({color:0x251919,roughness:.83});
  const glow = new THREE.MeshStandardMaterial({color:0xffb357,emissive:0xff4b1d,emissiveIntensity:1.9});
  const sphere = new THREE.SphereGeometry(1,12,10);
  const shard = new THREE.CylinderGeometry(.015,1,1,7,4);
  const vertices = shard.attributes.position;
  for(let i=0;i<vertices.count;i++){
    const t = vertices.getY(i)+.5;
    vertices.setX(i,vertices.getX(i)*(1+.16*Math.sin(vertices.getZ(i)*8))+t*t*.46);
    vertices.setZ(i,vertices.getZ(i)*.78-t*t*.48);
  }
  shard.computeVertexNormals();

  function lump(parent:THREE.Object3D, material:THREE.Material, x:number,y:number,z:number, sx:number,sy:number,sz:number, tilt=0) {
    const mesh = new THREE.Mesh(sphere,material);
    mesh.position.set(x,y,z);
    mesh.scale.set(sx,sy,sz);
    mesh.rotation.z = tilt;
    parent.add(mesh);
  }

  function ridge(parent:THREE.Group, material:THREE.Material, rings:Ring[], sculpt?:(x:number,y:number,z:number)=>number) {
    const sectors = 24, columns = sectors+1, positions:number[] = [], indices:number[] = [], uv:number[] = [];
    for(const [y,width,depth,centerZ=0] of rings){
      for(let side=0;side<=sectors;side++){
        const angle=(side%sectors)/sectors*Math.PI*2;
        const contour=1+.035*Math.sin(angle*5+y*9);
        const x=Math.cos(angle)*width*contour, z=Math.sin(angle)*depth*contour;
        positions.push(x,y,centerZ+z+(sculpt?.(x,y,z)??0));
        uv.push(side/sectors,y);
      }
    }
    for(let row=0;row<rings.length-1;row++){
      for(let side=0;side<sectors;side++){
        const a=row*columns+side,b=a+1;
        indices.push(a,a+columns,b,b,a+columns,b+columns);
      }
    }
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const normals=geometry.attributes.normal;
    const seam=new THREE.Vector3(), opposite=new THREE.Vector3();
    for(let row=0;row<rings.length;row++){
      const a=row*columns,b=a+sectors;
      seam.fromBufferAttribute(normals,a).add(opposite.fromBufferAttribute(normals,b)).normalize();
      normals.setXYZ(a,seam.x,seam.y,seam.z);
      normals.setXYZ(b,seam.x,seam.y,seam.z);
    }
    parent.add(new THREE.Mesh(geometry,material));
  }

  const up = new THREE.Vector3(0,1,0);
  function spike(parent:THREE.Group,x:number,y:number,z:number,dx:number,dy:number,dz:number,length:number,width:number,roll=0) {
    const direction = new THREE.Vector3(dx,dy,dz).normalize();
    const mesh = new THREE.Mesh(shard,bone);
    mesh.position.set(x,y,z).addScaledVector(direction,length*.47);
    mesh.scale.set(width,length,width);
    mesh.quaternion.setFromUnitVectors(up,direction);
    mesh.rotateY(roll);
    parent.add(mesh);
  }

  function chestContour(x:number,y:number,z:number) {
    const front=THREE.MathUtils.smoothstep(z,0,.20);
    const lateral=Math.abs(x);
    const muscle=(centerX:number,centerY:number,width:number,height:number)=>
      Math.exp(-(((lateral-centerX)/width)**2+((y-centerY)/height)**2));
    const pectoral=.122*muscle(.224,.19+lateral*.09,.142,.105);
    const ribs=.056*muscle(.155,-.04,.108,.057)+.047*muscle(.137,-.139,.09,.05)+.029*muscle(.121,-.23,.077,.047);
    return front*(pectoral+ribs);
  }

  const {torso,head,jaw} = rig;
  ridge(torso,skin,[
    [-.4,0,0],[-.34,.26,.195],[-.25,.27,.219],[-.21,.28,.23],[-.178,.285,.231],[-.14,.303,.237],
    [-.097,.326,.243],[-.05,.34,.255],[0,.363,.264],[.04,.396,.269],[.078,.412,.262],
    [.12,.43,.28,.005],[.17,.459,.276],[.21,.477,.26,-.012],[.24,.48,.25,-.03],
    [.285,.43,.228,-.044],[.34,.37,.21,-.045],[.41,.272,.18,-.015],
    [.46,.20,.165,.005],[.56,.13,.115,.035],[.59,0,0,.035],
  ],chestContour);
  lump(torso,hide,0,-.295,-.005,.29,.133,.22);
  for(const sign of [-1,1]){
    lump(torso,skin,sign*.25,.183,-.177,.215,.225,.135,-sign*.25);
    for(let rib=0;rib<3;rib++){
      spike(torso,sign*(.24+.04*rib),.06-rib*.11,.203,sign*.78,-.58,.5,.10+rib*.012,.037,sign);
    }
    for(let i=0;i<4;i++){
      spike(torso,sign*(.18+i*.041),.325-i*.101,-.207,sign*.55,.32,-1,.205-i*.016,.059,sign*.8);
    }
  }
  for(let i=0;i<7;i++)spike(torso,0,.402-i*.105,-.228,0,.52,-1,.285-i*.025,.076-i*.005,i*.35);

  ridge(head,skin,[
    [-.075,0,0],[-.045,.145,.13,.045],[.032,.177,.17,.04],[.105,.208,.205,.016],
    [.198,.199,.188,-.015],[.264,.146,.139,-.04],[.286,0,0,-.05],
  ]);
  lump(head,mouth,0,.019,.209,.133,.068,.068);
  lump(head,hide,0,.084,.203,.06,.05,.055);
  for(const sign of [-1,1])lump(head,mouth,sign*.028,.068,.251,.019,.009,.012,sign*.28);
  lump(jaw,hide,0,.006,.129,.146,.077,.135);
  lump(jaw,skin,0,-.033,.173,.12,.045,.089);
  for(let i=0;i<7;i++){
    const x=(i-3)*.033, z=.274-Math.abs(x)*.37;
    spike(head,x,.043,z,0,-1,.12,.038+(i%3)*.007,.014,i);
    spike(jaw,x,.039,z-.04,0,1,.13,.026+(i%2)*.011,.013,i);
  }
  for(const sign of [-1,1]){
    lump(head,hide,sign*.088,.127,.177,.088,.044,.059,sign*.27);
    lump(head,glow,sign*.086,.126,.222,.05,.014,.014,sign*.27);
    lump(head,bone,sign*.084,.166,.188,.109,.034,.055,sign*.31);
    lump(head,bone,sign*.16,.059,.15,.039,.074,.057,-sign*.32);
    spike(head,sign*.159,.059,.185,sign*.63,-.69,.35,.091,.034,sign*.4);
    spike(jaw,sign*.107,.017,.185,sign*.27,.91,.31,.073,.023,sign);
    for(let i=0;i<3;i++){
      spike(head,sign*(.136+i*.023),.218-i*.066,-.10-i*.01,sign*.51,.7,-.71,.15-i*.016,.044,sign*.6);
    }
  }

  for(const side of [0,1] as const){
    const sign = side===0 ? -1 : 1;
    const arm=rig.arms[side], forearm=rig.forearms[side], hand=rig.hands[side];
    const leg=rig.legs[side], shin=rig.shins[side], foot=rig.feet[side];
    ridge(arm,skin,[[-.419,0,0],[-.376,.116,.123],[-.243,.172,.154,.018],[-.117,.204,.194,.009],[.025,.206,.181],[.113,.117,.112],[.142,0,0]]);
    lump(arm,skin,-sign*.022,-.206,.058,.141,.177,.103,-sign*.19);
    lump(arm,hide,sign*.052,-.078,-.115,.156,.164,.108,sign*.26);
    for(let i=0;i<4;i++){
      spike(arm,sign*(.106+i*.018),.044-i*.074,-.053-i*.013,sign*(.55+i*.12),.76-i*.16,-.45,
        (side===1?.27:.215)-i*.024,.078-i*.008,sign*(.9+i*.25));
    }
    ridge(forearm,hide,[[-.335,0,0],[-.298,.105,.106],[-.185,.167,.136],[-.091,.184,.149,-.013],[.025,.12,.114],[.081,0,0]]);
    lump(forearm,skin,-sign*.019,-.151,.04,.154,.162,.109,sign*.1);
    for(let i=0;i<3;i++){
      spike(forearm,sign*(.09+i*.018),-.056-i*.076,-.083,sign*.75,.55-i*.2,-.71,
        i===0?(side===1?.39:.31):.21-i*.035,.081-i*.017,sign*.55);
    }
    lump(hand,skin,0,-.064,.013,.131,.128,.118);
    lump(hand,hide,-sign*.095,-.065,.073,.066,.088,.064,sign*.25);
    for(let i=0;i<4;i++){
      const x=(i-1.5)*.055;
      lump(hand,skin,x,-.133,.054,.039,.061,.069);
      spike(hand,x,-.114,.097,0,-.61,1,.079+(.5-Math.abs(i-1.5)/3)*.055,.028,i*.4);
    }

    ridge(leg,skin,[[-.418,0,0],[-.365,.116,.126,.018],[-.25,.151,.15,.018],[-.12,.191,.179],[.009,.191,.175],[.07,0,0]]);
    lump(leg,skin,sign*.023,-.148,.067,.145,.188,.133,sign*.13);
    ridge(shin,hide,[[-.409,0,0],[-.357,.101,.109],[-.221,.124,.126,-.028],[-.104,.14,.158,-.029],[-.009,.127,.135],[.074,0,0]]);
    lump(shin,bone,0,-.018,.096,.101,.093,.064,sign*.22);
    spike(shin,0,.027,.119,sign*.17,.80,.73,.097,.062,sign*.8);
    spike(shin,sign*.072,-.033,.108,sign*.58,.72,.87,.149,.051,sign);
    spike(shin,sign*.073,-.164,.075,sign*.55,.10,.88,.113,.044,sign);
    lump(foot,skin,0,-.029,.055,.127,.073,.198);
    for(let i=0;i<3;i++){
      const x=(i-1)*.073;
      lump(foot,hide,x,-.056,.198,.045,.045,.068);
      spike(foot,x,-.055,.228,x,-.19,1,.06,.031,i);
    }
  }
}
