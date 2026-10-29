import { RoadsterSimulator } from "@/components/roadster-sim/roadster-simulator";

export default function Home() {
  return (
    <main className="flex h-dvh flex-col">
      <h1 className="sr-only">Roadster Simulator</h1>
      <RoadsterSimulator />
    </main>
  );
}
