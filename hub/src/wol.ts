import wol from "wake_on_lan";
import { normalizeMac } from "./config.js";

export function wakeHost(mac: string, broadcastAddress = "255.255.255.255"): Promise<void> {
  const address = normalizeMac(mac);
  return new Promise((resolve, reject) => {
    wol.wake(
      address,
      {
        address: broadcastAddress,
        port: 9,
        num_packets: 3,
        interval: 100,
      },
      (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}
