/**
 * 场景线框预览（viewBox 0 0 120 200），悬停在场景卡片上时显示。
 * 只表达版式结构：色块 = 文字/图片，线框 = 卡片/容器。
 */
export const SCENE_SKETCH: Record<string, string> = {
  title:
    '<rect x="14" y="60" width="34" height="5" rx="2"/><rect x="14" y="76" width="92" height="13" rx="3"/><rect x="14" y="94" width="70" height="7" rx="2"/>',
  hero:
    '<rect x="8" y="26" width="104" height="118" rx="10" fill-opacity=".18"/><rect x="18" y="96" width="40" height="5" rx="2"/><rect x="18" y="110" width="86" height="15" rx="3"/><rect x="18" y="130" width="58" height="6" rx="2"/>',
  bigtext:
    '<rect x="14" y="58" width="80" height="20" rx="4"/><rect x="14" y="82" width="60" height="20" rx="4"/><rect x="14" y="118" width="46" height="6" rx="2"/>',
  caption:
    '<rect x="50" y="120" width="20" height="5" rx="2"/><rect x="16" y="134" width="88" height="10" rx="3"/><rect x="30" y="148" width="60" height="10" rx="3"/>',
  quote:
    '<rect x="18" y="70" width="3" height="60" rx="2"/><rect x="28" y="70" width="76" height="9" rx="2"/><rect x="28" y="84" width="66" height="9" rx="2"/><rect x="28" y="98" width="72" height="9" rx="2"/><rect x="28" y="120" width="34" height="5" rx="2"/>',
  bullets:
    '<rect x="14" y="52" width="50" height="7" rx="2"/><rect x="14" y="72" width="16" height="16" rx="4"/><rect x="36" y="74" width="60" height="8" rx="2"/><rect x="14" y="100" width="16" height="16" rx="4"/><rect x="36" y="102" width="54" height="8" rx="2"/><rect x="14" y="128" width="16" height="16" rx="4"/><rect x="36" y="130" width="64" height="8" rx="2"/>',
  list:
    '<rect x="14" y="60" width="20" height="10" rx="2"/><rect x="40" y="58" width="52" height="9" rx="2"/><rect x="14" y="86" width="20" height="10" rx="2"/><rect x="40" y="84" width="46" height="9" rx="2"/><rect x="14" y="112" width="20" height="10" rx="2"/><rect x="40" y="110" width="56" height="9" rx="2"/>',
  chart:
    '<rect x="14" y="50" width="60" height="7" rx="2"/><rect x="22" y="96" width="14" height="46" rx="2"/><rect x="44" y="78" width="14" height="64" rx="2"/><rect x="66" y="108" width="14" height="34" rx="2"/><rect x="88" y="68" width="14" height="74" rx="2"/>',
  ring:
    '<circle cx="60" cy="94" r="34" fill="none" stroke-width="10"/><rect x="40" y="150" width="40" height="7" rx="2"/><rect x="48" y="162" width="24" height="5" rx="2"/>',
  stats:
    '<rect x="14" y="56" width="54" height="8" rx="2"/><rect x="16" y="88" width="40" height="24" rx="3"/><rect x="16" y="120" width="26" height="5" rx="2"/><rect x="70" y="88" width="36" height="24" rx="3"/><rect x="70" y="120" width="24" height="5" rx="2"/>',
  image:
    '<rect x="10" y="30" width="100" height="130" rx="6" fill-opacity=".2"/><rect x="18" y="168" width="58" height="8" rx="2"/>',
  split:
    '<rect x="12" y="34" width="96" height="66" rx="6" fill-opacity=".2"/><rect x="12" y="112" width="60" height="11" rx="2"/><rect x="12" y="128" width="86" height="6" rx="2"/><rect x="12" y="140" width="70" height="6" rx="2"/>',
  compare:
    '<rect x="14" y="52" width="52" height="8" rx="2"/><rect x="12" y="76" width="44" height="60" rx="5"/><rect x="64" y="76" width="44" height="60" rx="5"/>',
  cards:
    '<rect x="12" y="48" width="48" height="56" rx="5"/><rect x="64" y="48" width="44" height="56" rx="5"/><rect x="12" y="112" width="48" height="56" rx="5"/><rect x="64" y="112" width="44" height="56" rx="5"/>',
  pricing:
    '<rect x="12" y="66" width="30" height="80" rx="5"/><rect x="46" y="56" width="30" height="90" rx="5"/><rect x="80" y="66" width="30" height="80" rx="5"/>',
  steps:
    '<circle cx="26" cy="60" r="7"/><rect x="40" y="55" width="58" height="8" rx="2"/><circle cx="26" cy="98" r="7"/><rect x="40" y="93" width="50" height="8" rx="2"/><circle cx="26" cy="136" r="7"/><rect x="40" y="131" width="54" height="8" rx="2"/>',
  timeline:
    '<rect x="26" y="46" width="2" height="108" rx="1"/><circle cx="27" cy="58" r="5"/><rect x="40" y="52" width="48" height="6" rx="2"/><circle cx="27" cy="94" r="5"/><rect x="40" y="88" width="56" height="6" rx="2"/><circle cx="27" cy="130" r="5"/><rect x="40" y="124" width="42" height="6" rx="2"/>',
  chat:
    '<rect x="16" y="48" width="62" height="20" rx="8"/><rect x="44" y="78" width="62" height="20" rx="8" fill-opacity=".5"/><rect x="16" y="108" width="54" height="20" rx="8"/><rect x="44" y="138" width="58" height="20" rx="8" fill-opacity=".5"/>',
  countdown:
    '<rect x="18" y="66" width="84" height="30" rx="4"/><rect x="34" y="112" width="52" height="9" rx="2"/><rect x="42" y="130" width="36" height="5" rx="2"/>',
  outro:
    '<rect x="42" y="58" width="36" height="5" rx="2"/><rect x="22" y="72" width="76" height="14" rx="3"/><rect x="40" y="94" width="40" height="6" rx="2"/><rect x="44" y="112" width="32" height="14" rx="7"/>',
  empty:
    '<rect x="10" y="10" width="100" height="180" rx="6" fill-opacity=".12"/><rect x="48" y="96" width="24" height="3" rx="1"/><rect x="58" y="86" width="3" height="24" rx="1"/>',
  life:
    '<rect x="16" y="44" width="32" height="5" rx="2"/><rect x="16" y="58" width="88" height="15" rx="3"/><rect x="16" y="80" width="60" height="6" rx="2"/><rect x="16" y="100" width="26" height="12" rx="6"/><rect x="48" y="100" width="26" height="12" rx="6"/><rect x="80" y="100" width="24" height="12" rx="6"/>',
  game:
    '<rect x="16" y="42" width="30" height="5" rx="2"/><rect x="16" y="56" width="92" height="16" rx="3"/><rect x="16" y="80" width="24" height="12" rx="6"/><rect x="44" y="80" width="24" height="12" rx="6"/><rect x="72" y="80" width="30" height="12" rx="6"/>',
  "game-stats":
    '<rect x="16" y="50" width="50" height="7" rx="2"/><rect x="18" y="86" width="36" height="22" rx="3"/><rect x="66" y="86" width="36" height="22" rx="3"/><rect x="18" y="116" width="26" height="5" rx="2"/><rect x="66" y="116" width="26" height="5" rx="2"/>',
  tech:
    '<rect x="16" y="42" width="30" height="5" rx="2"/><rect x="16" y="56" width="90" height="16" rx="3"/><rect x="16" y="80" width="24" height="12" rx="6"/><rect x="44" y="80" width="24" height="12" rx="6"/><rect x="72" y="80" width="28" height="12" rx="6"/>',
  edu:
    '<rect x="16" y="42" width="34" height="5" rx="2"/><rect x="16" y="56" width="92" height="16" rx="3"/><rect x="16" y="80" width="24" height="12" rx="6"/><rect x="44" y="80" width="24" height="12" rx="6"/><rect x="72" y="80" width="30" height="12" rx="6"/>',
  live:
    '<rect x="16" y="42" width="26" height="5" rx="2"/><rect x="16" y="56" width="90" height="16" rx="3"/><rect x="16" y="80" width="24" height="12" rx="6"/><rect x="44" y="80" width="24" height="12" rx="6"/><rect x="72" y="80" width="30" height="12" rx="6"/>',
  shop:
    '<rect x="16" y="42" width="30" height="5" rx="2"/><rect x="16" y="56" width="92" height="16" rx="3"/><rect x="16" y="80" width="24" height="12" rx="6"/><rect x="44" y="80" width="24" height="12" rx="6"/><rect x="72" y="80" width="28" height="12" rx="6"/>',
  gallery:
    '<rect x="10" y="40" width="48" height="72" rx="5"/><rect x="62" y="40" width="48" height="72" rx="5"/><rect x="10" y="120" width="48" height="50" rx="5"/><rect x="62" y="120" width="48" height="50" rx="5"/>',
  bars:
    '<rect x="14" y="54" width="54" height="7" rx="2"/><rect x="14" y="78" width="92" height="10" rx="5"/><rect x="14" y="96" width="4" height="4" rx="1"/><rect x="14" y="118" width="92" height="10" rx="5"/><rect x="14" y="136" width="4" height="4" rx="1"/><rect x="14" y="158" width="92" height="10" rx="5"/>',
  versus:
    '<rect x="8" y="44" width="44" height="80" rx="6"/><rect x="68" y="44" width="44" height="80" rx="6"/><circle cx="60" cy="84" r="10"/><rect x="34" y="140" width="52" height="9" rx="2"/>',
  qr:
    '<rect x="38" y="46" width="44" height="44" rx="4"/><rect x="46" y="54" width="28" height="28" rx="2" fill-opacity=".4"/><rect x="30" y="108" width="60" height="7" rx="2"/><rect x="40" y="124" width="40" height="5" rx="2"/>',
  rating:
    '<rect x="14" y="50" width="48" height="7" rx="2"/><circle cx="26" cy="84" r="6"/><circle cx="46" cy="84" r="6"/><circle cx="66" cy="84" r="6"/><circle cx="86" cy="84" r="6"/><circle cx="106" cy="84" r="6" fill-opacity=".35"/><rect x="14" y="106" width="76" height="6" rx="2"/><rect x="14" y="118" width="60" height="6" rx="2"/>',
  table:
    '<rect x="12" y="56" width="96" height="9" rx="2"/><rect x="12" y="76" width="96" height="1"/><rect x="16" y="88" width="30" height="6" rx="1"/><rect x="52" y="88" width="24" height="6" rx="1"/><rect x="82" y="88" width="22" height="6" rx="1"/><rect x="16" y="108" width="30" height="6" rx="1"/><rect x="52" y="108" width="24" height="6" rx="1"/><rect x="82" y="108" width="22" height="6" rx="1"/><rect x="16" y="128" width="30" height="6" rx="1"/><rect x="52" y="128" width="24" height="6" rx="1"/><rect x="82" y="128" width="22" height="6" rx="1"/>',
  tags:
    '<rect x="18" y="58" width="34" height="14" rx="7"/><rect x="58" y="52" width="42" height="16" rx="8" fill-opacity=".5"/><rect x="36" y="82" width="44" height="14" rx="7"/><rect x="16" y="106" width="30" height="12" rx="6" fill-opacity=".5"/><rect x="52" y="104" width="38" height="14" rx="7"/>',
  aurora:
    '<circle cx="34" cy="52" r="46" fill-opacity=".22"/><circle cx="88" cy="44" r="38" fill-opacity=".18"/><rect x="20" y="120" width="52" height="6" rx="2"/><rect x="20" y="134" width="84" height="16" rx="3"/><rect x="20" y="156" width="60" height="6" rx="2"/>',
  neon:
    '<rect x="16" y="86" width="88" height="18" rx="3" fill-opacity=".3"/><rect x="34" y="120" width="52" height="6" rx="2"/><rect x="46" y="132" width="28" height="4" rx="1"/>',
  stars:
    '<circle cx="26" cy="40" r="2"/><circle cx="88" cy="62" r="1.6"/><circle cx="58" cy="28" r="1.4"/><circle cx="40" cy="120" r="1.8"/><circle cx="96" cy="140" r="1.5"/><circle cx="16" cy="88" r="1.6"/><rect x="30" y="148" width="60" height="9" rx="2"/><rect x="42" y="162" width="36" height="5" rx="2"/>',
  team:
    '<circle cx="40" cy="76" r="14"/><circle cx="78" cy="76" r="14" fill-opacity=".5"/><rect x="30" y="98" width="20" height="5" rx="2"/><rect x="68" y="98" width="20" height="5" rx="2"/><rect x="42" y="130" width="36" height="7" rx="2"/>',
};
