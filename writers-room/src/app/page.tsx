import { Nav } from "@/components/Nav";
import { Recorder } from "@/components/Recorder";

export default function Home() {
  return (
    <>
      <main className="app">
        <Recorder />
      </main>
      <Nav />
    </>
  );
}
