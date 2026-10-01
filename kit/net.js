// IPs de este ordenador en la red local, ordenadas de más a menos probable
// (WiFi/Ethernet de casa u oficina antes que adaptadores virtuales o VPN).

const os = require('os');

const VIRTUAL = /virtual|vmware|vbox|hyper-v|vethernet|loopback|docker|wsl|tailscale|zerotier|vpn/i;

function score(name, ip) {
    let s = 0;
    if (ip.startsWith('192.168.')) s += 30;
    else if (ip.startsWith('10.')) s += 20;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) s += 10;
    if (VIRTUAL.test(name)) s -= 50;
    if (/wi-?fi|wlan|wireless|ethernet/i.test(name)) s += 5;
    return s;
}

function localIps() {
    const out = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family !== 'IPv4' && a.family !== 4) continue;
            if (a.internal || a.address.startsWith('169.254.')) continue;
            out.push({ name, ip: a.address, score: score(name, a.address) });
        }
    }
    return out.sort((a, b) => b.score - a.score);
}

module.exports = { localIps };
