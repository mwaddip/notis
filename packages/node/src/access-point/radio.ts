// NODE_INTERFACE → The access-point tool → "`setup` turns a box into an
// access point, in order" — step 2 reads the radio's combinations and radar
// channels from `iw list`; step 3 reads the connected Wi-Fi device from
// `nmcli dev`, its profile from `nmcli dev show <dev>`, its channel from
// `iw dev <dev> info`, and the scan from `nmcli dev wifi list`.

export interface IwCombination {
  // The one shape the access-point tool needs: a combination that carries
  // a managed (client) link and an AP interface together, on one channel.
  managedWithAp: boolean;
}

function unimplemented(_name: string): never {
  throw new Error('access-point: not implemented');
}

export function parseCombinations(_iwList: string): IwCombination {
  return unimplemented('parseCombinations');
}

export function parseRadarChannels(_iwList: string): Set<number> {
  return unimplemented('parseRadarChannels');
}

export interface Uplink {
  iface: string;
  ssid: string;
  channel: number;
}

export function parseUplink(_iwDevInfo: string): Uplink | null {
  return unimplemented('parseUplink');
}

export function parseScan(
  _nmcliWifiList: string,
): Array<{ ssid: string; channel: number }> {
  return unimplemented('parseScan');
}

export function parseConnectedWifi(_nmcliDev: string): string | null {
  return unimplemented('parseConnectedWifi');
}

export function parseGeneralConnection(_nmcliShow: string): string | null {
  return unimplemented('parseGeneralConnection');
}
