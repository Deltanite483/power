import * as THREE from 'three';

/** Camera-facing electric ribbons. One draw, 512 segments, shape updates at 20 Hz only. */
export class EnergyLightning {
  readonly mesh:THREE.Mesh<THREE.InstancedBufferGeometry,THREE.ShaderMaterial>;
  private readonly cap=512;
  private start=new Float32Array(this.cap*3);
  private end=new Float32Array(this.cap*3);
  private params=new Float32Array(this.cap*2);
  private color=new Float32Array(this.cap*3);
  private count=0;
  private time=0;
  private refresh=0;
  private burstAge=1;
  private burstRadius=0;
  private burstOrigin=new THREE.Vector3();
  private a=new THREE.Vector3();
  private b=new THREE.Vector3();
  private branch=new THREE.Vector3();
  private forkStart=new THREE.Vector3();
  private forkEnd=new THREE.Vector3();

  constructor(scene:THREE.Scene){
    const geometry=new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,0,0,1,0,0,-1,1,0,-1,1,0,1,0,0,1,1,0],3));
    for(const [name,array,size] of [['aStart',this.start,3],['aEnd',this.end,3],['aParams',this.params,2],['aColor',this.color,3]] as const)
      geometry.setAttribute(name,new THREE.InstancedBufferAttribute(array,size).setUsage(THREE.DynamicDrawUsage));
    geometry.instanceCount=0;
    const material=new THREE.ShaderMaterial({
      uniforms:{uHeight:{value:900}},transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide,toneMapped:false,
      vertexShader:/* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 aStart,aEnd,aColor;
        attribute vec2 aParams;
        uniform float uHeight;
        varying float vSide,vAlpha;
        varying vec3 vColor;
        void main(){
          vec4 a=viewMatrix*vec4(aStart,1.0),b=viewMatrix*vec4(aEnd,1.0);
          vec4 mv=mix(a,b,position.y);
          vec2 delta=b.xy-a.xy;
          vec2 side=length(delta)>.0001?normalize(vec2(-delta.y,delta.x)):vec2(1.0,0.0);
          float pixel=2.0*max(1.0,-mv.z)/(projectionMatrix[1][1]*uHeight);
          mv.xy+=side*position.x*max(aParams.x*3.2,pixel*3.0);
          gl_Position=projectionMatrix*mv;
          #include <logdepthbuf_vertex>
          vSide=position.x;vAlpha=aParams.y;vColor=aColor;
        }`,
      fragmentShader:/* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying float vSide,vAlpha;
        varying vec3 vColor;
        void main(){
          #include <logdepthbuf_fragment>
          // A hair-thin white-hot filament inside a wide red corona.
          float x=abs(vSide);
          float core=exp(-x*x*90.0), glow=exp(-x*x*7.0)*.42;
          float alpha=(core+glow)*vAlpha*(1.0-smoothstep(.85,1.0,x));
          if(alpha<.005)discard;
          gl_FragColor=vec4(mix(vColor,vec3(4.0,2.6,2.4),core),min(1.0,alpha));
          #include <colorspace_fragment>
        }`,
    });
    this.mesh=new THREE.Mesh(geometry,material);this.mesh.frustumCulled=false;this.mesh.renderOrder=8;this.mesh.visible=false;scene.add(this.mesh);
  }

  clear(){this.burstAge=1;this.burstRadius=0;this.count=0;this.mesh.geometry.instanceCount=0;this.mesh.visible=false;this.refresh=0;}
  burst(origin:THREE.Vector3,radius:number){this.burstOrigin.copy(origin);this.burstRadius=Math.min(240,radius);this.burstAge=0;this.refresh=0;}
  private hash(seed:number){const n=Math.sin(seed*127.1)*43758.5453;return n-Math.floor(n);}
  private arc(a:THREE.Vector3,b:THREE.Vector3,jitter:number,segments:number,seed:number,alpha:number,width:number,fork=true){
    let x=a.x,y=a.y,z=a.z;
    for(let i=1;i<=segments && this.count<this.cap;i++){
      const t=i/segments,envelope=Math.sin(t*Math.PI),noise=seed+i*7;
      const nx=a.x+(b.x-a.x)*t+(this.hash(noise)-.5)*jitter*envelope;
      const ny=a.y+(b.y-a.y)*t+(this.hash(noise+1)-.5)*jitter*envelope;
      const nz=a.z+(b.z-a.z)*t+(this.hash(noise+2)-.5)*jitter*envelope;
      const slot=this.count++,k=slot*3;
      this.start[k]=x;this.start[k+1]=y;this.start[k+2]=z;
      this.end[k]=nx;this.end[k+1]=ny;this.end[k+2]=nz;
      this.params[slot*2]=width*(.7+this.hash(noise+5)*.6);this.params[slot*2+1]=alpha*(.55+this.hash(noise+3)*.45);
      this.color[k]=2.6;this.color[k+1]=.03;this.color[k+2]=.05;
      // Bolts fork: now and then a thinner offshoot peels away for a few segments.
      if(fork && i>2 && i<segments-2 && this.hash(noise+9)>.8){
        const reach=jitter*(1.2+this.hash(noise+11)*1.6);
        this.forkEnd.set(nx+(this.hash(noise+12)-.5)*reach*2,ny+(this.hash(noise+13)-.2)*reach*1.4,nz+(this.hash(noise+14)-.5)*reach*2);
        this.forkStart.set(nx,ny,nz);
        this.arc(this.forkStart,this.forkEnd,jitter*.6,4,noise+50,alpha*.55,width*.6,false);
      }
      x=nx;y=ny;z=nz;
    }
  }

  update(dt:number,source:THREE.Vector3,charge=0,beamEnd:THREE.Vector3|null=null){
    this.time+=Math.max(0,dt);this.refresh-=dt;this.burstAge+=dt;
    const bursting=this.burstRadius>0 && this.burstAge<.6;
    if(charge<=0 && !beamEnd && !bursting){this.mesh.visible=false;this.refresh=0;return;}
    this.mesh.visible=true;
    if(this.refresh>0)return;
    this.refresh=.05;this.count=0;
    const seed=Math.floor(this.time*20)*3.7;
    const radius=1+charge*2.7;
    if(charge>0)for(let i=0;i<6+Math.ceil(charge*6);i++){
      const angle=i*2.4+seed*.1,height=(this.hash(seed+i)-.5)*2;
      this.a.copy(source);this.a.x+=Math.cos(angle)*.6;this.a.z+=Math.sin(angle)*.6;
      this.b.copy(source);this.b.x+=Math.cos(angle+.6)*radius;this.b.z+=Math.sin(angle+.6)*radius;this.b.y+=height*radius;
      this.arc(this.a,this.b,.8+charge,10,seed+i,.4+charge*.5,.035);
    }
    if(beamEnd)for(let i=0;i<4;i++){
      this.a.copy(source);this.b.copy(beamEnd);
      this.arc(this.a,this.b,Math.min(2,.4+source.distanceTo(beamEnd)*.012),18,seed+i*5,.9,.04);
    }
    if(bursting){
      const spread=this.burstRadius*(.18+.82*this.burstAge/.6),alpha=1-this.burstAge/.6;
      for(let i=0;i<12;i++){
        const angle=i*Math.PI/6+this.hash(seed+i)*.15;
        this.a.copy(this.burstOrigin);this.b.copy(this.a);
        this.b.x+=Math.cos(angle)*spread;this.b.z+=Math.sin(angle)*spread;this.b.y+=this.hash(seed+i+4)*7;
        this.arc(this.a,this.b,Math.min(8,spread*.15),16,seed+i,alpha,.075);
        if(i%2===0){
          this.a.lerp(this.b,.65);this.branch.copy(this.b);this.branch.x+=Math.sin(angle)*spread*.18;this.branch.z-=Math.cos(angle)*spread*.18;
          this.arc(this.a,this.branch,2,8,seed+i+30,alpha*.7,.045);
        }
      }
    }
    const geometry=this.mesh.geometry;geometry.instanceCount=this.count;
    for(const name of ['aStart','aEnd','aParams','aColor']){
      const attribute=geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
      attribute.clearUpdateRanges();attribute.addUpdateRange(0,this.count*attribute.itemSize);attribute.needsUpdate=true;
    }
    if(typeof innerHeight!=='undefined')this.mesh.material.uniforms.uHeight.value=innerHeight*Math.min(typeof devicePixelRatio==='number'?devicePixelRatio:1,1.5);
  }
}
