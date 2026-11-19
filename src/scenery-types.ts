export type Point2 = [number, number];
export interface RoadData { id: number; name: string; kind: string; bridge: boolean; tunnel: boolean; width: string | null; points: Point2[]; }
export interface BuildingData { id: number; name: string; kind: string; height: string | null; levels: string | null; roof: string | null; points: Point2[]; }
export interface SceneryData { source: string; roads: RoadData[]; buildings: BuildingData[]; }
