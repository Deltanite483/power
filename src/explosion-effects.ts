import * as THREE from "three";

/** Twelve five-lobe blasts in one draw call. Only new bursts upload attributes; motion runs on the GPU. */
export class Explosions {
  readonly group=new THREE.Group();
  private readonly cap=60;
  private head=0;
  private time=0;
  private births=new Float64Array(12).fill(-1e9);
  private origin=new Float32Array(this.cap*3);
  private direction=new Float32Array(this.cap*3);
  private params=new Float32Array(this.cap*4);
  private geometry=new THREE.InstancedBufferGeometry();
  private uniforms={uTime:{value:0}};
  private cameraPosition=new THREE.Vector3();
  private cameraKnown=false;
  private lastPosition=new THREE.Vector3();
  private lastBirth=-Infinity;

  constructor(){
    const sphere=new THREE.IcosahedronGeometry(1,1);
    this.geometry.setAttribute("position",sphere.getAttribute("position"));
    this.geometry.setAttribute("normal",sphere.getAttribute("normal"));
    this.geometry.instanceCount=this.cap;
    for(let i=0;i<this.cap;i++)this.params[i*4]=-1e9;
    for(const [name,array,size] of [["aOrigin",this.origin,3],["aDirection",this.direction,3],["aBurst",this.params,4]] as const)
      this.geometry.setAttribute(name,new THREE.InstancedBufferAttribute(array,size).setUsage(THREE.DynamicDrawUsage));
    const material=new THREE.ShaderMaterial({
      uniforms:this.uniforms,transparent:true,depthWrite:false,
      vertexShader:/* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 aOrigin,aDirection;
        attribute vec4 aBurst;
        uniform float uTime;
        varying float vAge,vHeat;
        varying vec3 vNormal,vView,vLocal;
        void main(){
          vLocal=position*3.0+aBurst.w;
          float age=uTime-aBurst.x;
          if(age<0.0 || age>1.05){gl_Position=vec4(2.0,2.0,2.0,1.0);return;}
          float t=age/1.05, expand=1.0-exp(-age*7.0);
          float scale=aBurst.y*aBurst.z*(0.08+expand*.72);
          vec3 p=position*(1.0+.08*sin(position.y*9.0+aBurst.w+age*5.0));
          float angle=aBurst.w+age*.4;
          mat2 rotation=mat2(cos(angle),-sin(angle),sin(angle),cos(angle));
          p.xz=rotation*p.xz;
          vec3 wp=aOrigin+aDirection*aBurst.y*expand*.8+p*scale;
          wp.y+=aBurst.y*age*.22;
          vec4 mv=viewMatrix*vec4(wp,1.0);
          gl_Position=projectionMatrix*mv;
          #include <logdepthbuf_vertex>
          vec3 n=normal;n.xz=rotation*n.xz;
          vNormal=mat3(viewMatrix)*n;vView=-mv.xyz;
          vAge=t;vHeat=.7+.3*sin(position.y*7.0+position.x*11.0+aBurst.w);
        }`,
      fragmentShader:/* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying float vAge,vHeat;
        varying vec3 vNormal,vView,vLocal;
        float hash3(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
        float noise3(vec3 p){
          vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
          return mix(mix(mix(hash3(i),hash3(i+vec3(1,0,0)),f.x),mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x),f.y),
            mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x),mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x),f.y),f.z);
        }
        void main(){
          #include <logdepthbuf_fragment>
          // Rolling turbulence: bright cells of flame separated by darker, cooler seams that open up as it burns out.
          float churn=noise3(vLocal+vec3(0.0,-vAge*2.5,0.0))*.65+noise3(vLocal*2.3+vAge*3.0)*.35;
          float heat=clamp(1.15-vAge*1.9+(churn-.5)*.9,0.0,1.0);
          vec3 color=mix(vec3(.12,.09,.08),vec3(1.5,.3,.03),smoothstep(0.0,.4,heat));
          color=mix(color,vec3(3.2,1.7,.5),smoothstep(.35,.75,heat));
          color=mix(color,vec3(3.4,3.0,2.2),smoothstep(.75,1.0,heat));
          float edge=pow(clamp(dot(normalize(vNormal),normalize(vView)),0.0,1.0),.55);
          float alpha=(1.0-smoothstep(.35,1.0,vAge))*.82*edge*smoothstep(vAge*.75-.1,vAge*.75+.25,churn+.25);
          if(alpha<.005)discard;
          gl_FragColor=vec4(color*vHeat,alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh=new THREE.Mesh(this.geometry,material);mesh.frustumCulled=false;
    this.group.add(mesh);this.group.visible=false;
  }

  spawn(p:THREE.Vector3,normal:THREE.Vector3,radius:number, nuclear=false){
    if(this.cameraKnown && p.distanceTo(this.cameraPosition)>Math.max(600,radius*160))return;
    if(!nuclear && this.time-this.lastBirth<.05 && p.distanceToSquared(this.lastPosition)<Math.max(1,radius*.5)**2)return;
    this.lastBirth=this.time;this.lastPosition.copy(p);
    const first=this.head*5,r=Math.min(nuclear?85:22,Math.max(.5,radius));
    this.births[this.head]=this.time;this.head=(this.head+1)%12;
    for(let lobe=0;lobe<5;lobe++){
      const i=first+lobe,k=i*3;
      this.origin[k]=p.x+normal.x*r*.16;this.origin[k+1]=p.y+normal.y*r*.16;this.origin[k+2]=p.z+normal.z*r*.16;
      const angle=lobe*Math.PI*.5+Math.random()*.5;
      this.direction[k]=lobe?Math.cos(angle)*.6+normal.x*.4:0;
      this.direction[k+1]=lobe?.2+Math.random()*.3+normal.y*.3:0;
      this.direction[k+2]=lobe?Math.sin(angle)*.6+normal.z*.4:0;
      this.params.set([this.time,r,lobe?.3+Math.random()*.3:.85,Math.random()*20],i*4);
    }
    for(const [name,size] of [["aOrigin",3],["aDirection",3],["aBurst",4]] as const){
      const attribute=this.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
      attribute.addUpdateRange(first*size,5*size);attribute.needsUpdate=true;
    }
    this.group.visible=true;
  }

  update(dt:number,camera?:THREE.Camera){
    if(camera){this.cameraPosition.copy(camera.position);this.cameraKnown=true;}
    this.time+=dt;this.uniforms.uTime.value=this.time;
    this.group.visible=this.births.some(birth=>this.time-birth<1.05);
  }
}

/** Dust and spray: soft lit puffs that billow out, slow down, rise a little and fade. */
export class Dust {
  readonly points: THREE.Points;
  private readonly n = 2400;
  private head = 0;
  private start: Float32Array;
  private vel: Float32Array;
  private birth: Float32Array;
  private life: Float32Array;
  private size: Float32Array;
  private color: Float32Array;
  private style: Float32Array;
  private cameraPosition=new THREE.Vector3();
  private cameraKnown=false;
  private emitted=0;
  private frameTime=1/60;
  private detail=1;
  get quality(){return this.detail;}
  private dirty: [number, number][] = [];
  private uniforms = {
    uTime: { value: 0 },
    uPixelScale: { value: 500 },
    uPointLimit: { value: 144 },
  };

  constructor() {
    this.start = new Float32Array(this.n * 3);
    this.vel = new Float32Array(this.n * 3);
    this.birth = new Float32Array(this.n).fill(-1e9);
    this.life = new Float32Array(this.n).fill(1);
    this.size = new Float32Array(this.n * 2);
    this.color = new Float32Array(this.n * 3);
    this.style = new Float32Array(this.n * 3);
    const g = new THREE.BufferGeometry();
    const dyn = (a: Float32Array, k: number) => new THREE.BufferAttribute(a, k).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", dyn(this.start, 3));
    g.setAttribute("aVel", dyn(this.vel, 3));
    g.setAttribute("aBirth", dyn(this.birth, 1));
    g.setAttribute("aLife", dyn(this.life, 1));
    g.setAttribute("aSize", dyn(this.size, 2));
    g.setAttribute("aColor", dyn(this.color, 3));
    g.setAttribute("aStyle", dyn(this.style, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 aVel, aColor, aStyle;
        attribute float aBirth, aLife;
        attribute vec2 aSize;
        uniform float uTime, uPixelScale, uPointLimit;
        varying float vAlpha, vSeed, vAge;
        varying vec2 vSpin;
        varying vec3 vColor;
        void main() {
          float age = uTime - aBirth;
          if (age < 0.0 || age > aLife) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
          float t = age / aLife;
          // thrown out fast, braked hard by the air, then drifting up and downwind
          float seed=aStyle.z,drag=max(.4,aStyle.x);
          vec3 curl=vec3(sin(age*.8+seed),sin(age*.6+seed*2.0)*.35,cos(age*.7+seed));
          vec3 wp = position + aVel * (1.0 - exp(-age * drag)) / drag + vec3(1.2, aStyle.y, .5) * age;
          wp+=curl*aSize.y*.12*smoothstep(0.0,1.2,age);
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
          float size = mix(aSize.x, aSize.y, sqrt(t));
          float px = size * uPixelScale / max(0.1, -mv.z);
          gl_PointSize = min(px, uPointLimit);
          vAlpha = 0.5 * pow(1.0 - t, 1.3) * smoothstep(0.0, 0.06, age) * smoothstep(0.5, 3.0, -mv.z) * (px > uPointLimit ? uPointLimit / px : 1.0);
          vSeed = fract(seed);vAge=age;
          vSpin=vec2(cos(seed+age*.13),sin(seed+age*.13));
          vColor = aColor;
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying float vAlpha, vSeed, vAge;
        varying vec2 vSpin;
        varying vec3 vColor;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec2 c = gl_PointCoord - 0.5;
          if(dot(c,c)>.25 || vAlpha<.004)discard;
          vec2 q=mat2(vSpin.x,-vSpin.y,vSpin.y,vSpin.x)*c*4.0+vSeed*17.0+vec2(vAge*.12,0.0);
          float n = noise(q);
          float a = (1.0-smoothstep(.12,1.0,length(c)*2.0+(n-.5)*.65))*vAlpha;
          if (a < 0.004) discard;
          float lit = clamp(0.6 - c.y * 0.8 + (n - 0.5) * 0.4, 0.0, 1.0);
          gl_FragColor = vec4(vColor * mix(0.65, 1.1, lit), a);
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  private time = 0;

  /** count puffs from (x,y,z) around n; speed of the billow; size grows from s0 to s1 over the life. */
  burst(x: number, y: number, z: number, n: THREE.Vector3, count: number, speed: number, s1: number, rgb: [number, number, number], life: number, profile=0) {
    const distance=this.cameraKnown?Math.hypot(x-this.cameraPosition.x,y-this.cameraPosition.y,z-this.cameraPosition.z):0;
    if(distance>6000)return;
    const lod=THREE.MathUtils.clamp(500/Math.max(500,distance),.12,1);
    count = Math.min(90, 180-this.emitted, Math.max(1, Math.round(count * .35 * lod * this.detail)));
    if(count<=0)return;
    this.emitted+=count;
    s1=Math.min(s1,48);
    life = Math.min(life, 5);
    const c = new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    const first = this.head;
    const axis=profile===1?n.clone().normalize():null;
    const tangent=axis?new THREE.Vector3().crossVectors(axis,Math.abs(axis.y)>.9?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0)).normalize():null;
    const bitangent=axis && tangent?new THREE.Vector3().crossVectors(axis,tangent):null;
    for (let k = 0; k < count; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.n;
      const angle=Math.random()*Math.PI*2;
      const dx = tangent && bitangent && axis?tangent.x*Math.cos(angle)+bitangent.x*Math.sin(angle)+axis.x*.08:n.x + (Math.random() - 0.5) * 2;
      const dy = tangent && bitangent && axis?tangent.y*Math.cos(angle)+bitangent.y*Math.sin(angle)+axis.y*.08:n.y * .6 + Math.random() * .8;
      const dz = tangent && bitangent && axis?tangent.z*Math.cos(angle)+bitangent.z*Math.sin(angle)+axis.z*.08:n.z + (Math.random() - 0.5) * 2;
      const l = Math.hypot(dx, dy, dz) || 1, sp = speed * (0.3 + Math.random() * 0.9) * 2;
      this.start[i * 3] = x + (Math.random() - 0.5); this.start[i * 3 + 1] = y + Math.random() * 0.5; this.start[i * 3 + 2] = z + (Math.random() - 0.5);
      this.vel[i * 3] = (dx / l) * sp; this.vel[i * 3 + 1] = (dy / l) * sp; this.vel[i * 3 + 2] = (dz / l) * sp;
      this.birth[i] = this.time+(profile===2?Math.random()*.15:0);
      this.style.set([profile===1?2.4:1.4,profile===1?.12:profile===2?1.2:.5,Math.random()*20],i*3);
      this.life[i] = life * (0.6 + Math.random() * 0.8);
      this.size[i * 2] = s1 * 0.25; this.size[i * 2 + 1] = s1 * (0.7 + Math.random() * 0.6);
      const j = 0.85 + Math.random() * 0.25;
      this.color[i * 3] = c.r * j; this.color[i * 3 + 1] = c.g * j; this.color[i * 3 + 2] = c.b * j;
    }
    this.dirty.push([first, count]);
  }

  /** Dense rising billow plus a flatter, fast radial dust skirt, within the same particle pool. */
  explosion(p:THREE.Vector3,normal:THREE.Vector3,radius:number,rgb:[number,number,number]){
    this.burst(p.x,p.y+.3,p.z,normal,Math.min(180,25+radius*14),4+radius*.65,Math.min(32,5+radius*1.6),rgb,4.5,2);
    this.burst(p.x,p.y+.2,p.z,normal,Math.min(100,16+radius*6),6+radius,Math.min(18,3+radius*.6),rgb,2.8,1);
  }

  update(time: number, camera: THREE.Camera, frameDt=1/60) {
    this.time = time;
    this.emitted=0;this.cameraPosition.copy(camera.position);this.cameraKnown=true;
    this.frameTime+=(Math.min(.1,Math.max(0,frameDt))-this.frameTime)*(1-Math.exp(-Math.max(0,frameDt)*2));
    this.detail=THREE.MathUtils.clamp((.035-this.frameTime)/.018,.35,1);
    this.uniforms.uPointLimit.value=80+64*this.detail;
    this.uniforms.uTime.value = time;
    const cam = camera as THREE.PerspectiveCamera;
    this.uniforms.uPixelScale.value = innerHeight * Math.min(devicePixelRatio, 1.5) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    if (!this.dirty.length) return;
    const g = this.points.geometry;
    for (const [name, k] of [["position", 3], ["aVel", 3], ["aBirth", 1], ["aLife", 1], ["aSize", 2], ["aColor", 3], ["aStyle",3]] as const) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      for (const [first, count] of this.dirty) {
        const end = first + count;
        if (end <= this.n) a.addUpdateRange(first * k, count * k);
        else { a.addUpdateRange(first * k, (this.n - first) * k); a.addUpdateRange(0, (end - this.n) * k); }
      }
      a.needsUpdate = true;
    }
    this.dirty.length = 0;
  }
}

interface Wave {
  mesh:THREE.Mesh<THREE.RingGeometry,THREE.ShaderMaterial>|null;
  position:THREE.Vector3;t:number;r:number;normal:THREE.Vector3;previous:number;hit:Set<object|number>;nuclear:boolean;duration:number;
}

/** Soft, broken pressure fronts. Visuals are pooled; every wave still runs its gameplay sweep. */
export class Shockwaves {
  readonly group=new THREE.Group();
  private readonly geometry=new THREE.RingGeometry(.78,1,64);
  private pool:THREE.Mesh<THREE.RingGeometry,THREE.ShaderMaterial>[]=[];
  private rings:Wave[]=[];
  get activeCount() { return this.rings.length; }
  private static readonly Z=new THREE.Vector3(0,0,1);
  onSweep:(origin:THREE.Vector3,normal:THREE.Vector3,previous:number,radius:number,strength:number,hit:Set<object|number>)=>void=()=>{};

  constructor(){
    for(let i=0;i<24;i++){
      const material=new THREE.ShaderMaterial({
        transparent:true,depthWrite:false,side:THREE.DoubleSide,
        uniforms:{uOpacity:{value:0},uPhase:{value:i*2.3},uNuclear:{value:0}},
        vertexShader:/* glsl */`
          #include <common>
          #include <logdepthbuf_pars_vertex>
          varying vec2 vPosition;
          void main(){
            vPosition=position.xy;
            vec4 mvPosition=modelViewMatrix*vec4(position,1.0);
            gl_Position=projectionMatrix*mvPosition;
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader:/* glsl */`
          #include <common>
          #include <logdepthbuf_pars_fragment>
          uniform float uOpacity,uPhase,uNuclear;
          varying vec2 vPosition;
          void main(){
            #include <logdepthbuf_fragment>
            float r=length(vPosition),angle=atan(vPosition.y,vPosition.x);
            // A razor-bright compression front, a rarefaction band just behind it, and torn vapour trailing inside.
            float torn=.5+.5*sin(angle*7.0+uPhase)*sin(angle*13.0-uPhase*1.7);
            float streak=.5+.3*torn+.2*sin(angle*29.0+uPhase*3.0);
            float rim=exp(-pow((r-.968)/.009,2.0))*1.5+exp(-pow((r-.955)/.03,2.0))*.45;
            float second=exp(-pow((r-.915)/.012,2.0))*.5;
            float wake=exp(-pow((r-.86)/.06,2.0))*.4*streak;
            float edge=smoothstep(.78,.82,r)*(1.0-smoothstep(.985,1.0,r));
            float alpha=min(1.0,(rim*(.75+.25*torn)+second*streak+wake)*edge*uOpacity);
            if(alpha<.003)discard;
            vec3 wakeColor=mix(vec3(.72,.76,.8),vec3(1.0,.28,.06),uNuclear);
            vec3 rimColor=mix(vec3(1.0,.99,.96),vec3(1.0,.9,.62),uNuclear);
            gl_FragColor=vec4(mix(wakeColor,rimColor,clamp(rim,0.0,1.0)),alpha);
            #include <colorspace_fragment>
          }`,
      });
      const mesh=new THREE.Mesh(this.geometry,material);mesh.visible=false;mesh.renderOrder=7;
      this.pool.push(mesh);this.group.add(mesh);
    }
  }

  spawn(x:number,y:number,z:number,R:number,facing?:THREE.Vector3,delay=0,exempt?:object|readonly object[],sharedHits?:Set<object|number>,nuclear=false,duration=nuclear?1.05:.8){
    let mesh=this.pool.pop()??null;
    if(!mesh){
      // Retire only the oldest visual. Its physical pressure front continues to affect the world.
      const old=this.rings.find(ring=>ring.mesh!==null);
      if(old){mesh=old.mesh;old.mesh=null;}
    }
    const normal=facing?facing.clone().normalize():new THREE.Vector3(0,1,0);
    if(mesh){
      mesh.quaternion.setFromUnitVectors(Shockwaves.Z,normal);mesh.position.set(x,y,z);
      mesh.scale.setScalar(.001);mesh.material.uniforms.uOpacity.value=0;mesh.material.uniforms.uNuclear.value=nuclear?1:0;mesh.visible=false;
    }
    const hit=sharedHits??new Set<object|number>();
    if(Array.isArray(exempt))for(const item of exempt)hit.add(item);
    else if(exempt)hit.add(exempt);
    this.rings.push({mesh,position:new THREE.Vector3(x,y,z),t:-delay,r:R,normal,previous:0,hit,nuclear,duration});
  }

  update(dt:number){
    for(let i=this.rings.length-1;i>=0;i--){
      const ring=this.rings[i];ring.t+=dt;if(ring.t<0)continue;
      const t=Math.min(1,ring.t/ring.duration),ease=t*t*(3-2*t);
      const radius=ring.r*(.6+5*ease);
      this.onSweep(ring.position,ring.normal,ring.previous,radius,ring.r,ring.hit);ring.previous=radius;
      if(ring.mesh){ring.mesh.visible=true;ring.mesh.scale.set(radius,radius,1);ring.mesh.material.uniforms.uOpacity.value=ring.nuclear ? .95*(1-t)**.65 : .72*(1-t)**1.7;}
      if(t>=1){
        if(ring.mesh){ring.mesh.visible=false;this.pool.push(ring.mesh);}
        this.rings.splice(i,1);
      }
    }
  }
}

