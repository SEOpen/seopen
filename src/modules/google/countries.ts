/** Search Console reports ISO-3166 alpha-3 codes; Intl.DisplayNames wants alpha-2. */
const A3_TO_A2: Record<string, string> = Object.fromEntries(
  (
    "usa:US gbr:GB can:CA aus:AU nzl:NZ irl:IE deu:DE fra:FR esp:ES ita:IT nld:NL bel:BE che:CH aut:AT swe:SE nor:NO dnk:DK fin:FI isl:IS " +
    "prt:PT pol:PL cze:CZ svk:SK hun:HU rou:RO bgr:BG grc:GR hrv:HR svn:SI srb:RS ukr:UA rus:RU blr:BY ltu:LT lva:LV est:EE tur:TR isr:IL " +
    "are:AE sau:SA qat:QA kwt:KW egy:EG mar:MA zaf:ZA nga:NG ken:KE gha:GH ind:IN pak:PK bgd:BD lka:LK npl:NP chn:CN hkg:HK twn:TW jpn:JP " +
    "kor:KR sgp:SG mys:MY tha:TH vnm:VN phl:PH idn:ID mex:MX bra:BR arg:AR chl:CL col:CO per:PE ven:VE ecu:EC ury:UY pry:PY bol:BO cri:CR " +
    "pan:PA gtm:GT dom:DO pri:PR cub:CU jam:JM tto:TT lux:LU mlt:MT cyp:CY geo:GE arm:AM aze:AZ kaz:KZ uzb:UZ irn:IR irq:IQ jor:JO lbn:LB " +
    "tun:TN dza:DZ eth:ET tza:TZ uga:UG zwe:ZW zmb:ZM ago:AO cmr:CM civ:CI sen:SN mmr:MM khm:KH mng:MN alb:AL mkd:MK bih:BA mne:ME mda:MD"
  )
    .split(" ")
    .map((p) => p.split(":")),
);

const names = new Intl.DisplayNames(["en"], { type: "region" });

export function countryName(alpha3: string): string {
  const a2 = A3_TO_A2[alpha3.toLowerCase()];
  if (!a2) return alpha3 === "zzz" ? "Unknown region" : alpha3.toUpperCase();
  return names.of(a2) ?? alpha3.toUpperCase();
}

export function deviceName(device: string): string {
  return device.charAt(0) + device.slice(1).toLowerCase();
}
