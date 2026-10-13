export const SEED_CARD_UI_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;padding:12px 12px 24px;background:#f2f2f7;color:#1b1f27;
  font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:14px;line-height:1.6}
h1{margin:4px 0 2px;font-size:20px;color:#0072e3;text-align:center}
h2{margin:18px 0 8px;font-size:15px;color:#0072e3}
.sub{text-align:center;font-size:12px;color:#8a90a0;margin-bottom:12px}
.searchbar{display:flex;gap:8px;margin-bottom:10px}
.searchbar input{flex:1;padding:11px 14px;border:1px solid rgba(16,24,40,.08);border-radius:14px;font-size:13px;outline:none;background:#fff}
.searchbar button{border:0;border-radius:9999px;padding:0 18px;background:#0072e3;color:#fff;font-size:13px;font-weight:600;
  box-shadow:0 6px 18px rgba(0,114,227,.28)}
.pill{display:block;width:100%;border:0;border-radius:9999px;padding:12px;margin:0 0 12px;font-size:13px;font-weight:600;color:#fff;
  background:linear-gradient(180deg,#4cc06a,#2ea34e);box-shadow:0 8px 22px rgba(46,163,78,.28)}
.picked{background:#eef5ff;border:1px solid rgba(0,114,227,.22);border-radius:16px;padding:12px;margin-bottom:14px}
.picked-head{display:flex;justify-content:space-between;font-weight:600;color:#0072e3;font-size:14px}
.picked-desc{font-size:11px;color:#8a90a0;margin:4px 0 8px;line-height:1.5}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips .empty{font-size:12px;color:#9aa0b0}
.chip{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid rgba(0,114,227,.24);border-radius:9999px;
  padding:5px 10px;font-size:12px;color:#0072e3;box-shadow:0 1px 3px rgba(16,24,40,.05)}
.chip b{cursor:pointer;font-weight:400;opacity:.6}
.cat{margin-bottom:8px;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 2px 10px rgba(16,24,40,.05)}
.cat-head{display:flex;width:100%;align-items:center;justify-content:space-between;border:0;background:linear-gradient(180deg,#3b9bff,#0072e3);
  color:#fff;font-size:13px;font-weight:600;padding:12px 14px;text-align:left}
.cat-head i{font-style:normal;transition:transform .15s;opacity:.9}
.cat.open .cat-head i{transform:rotate(90deg)}
.cat-body{display:none;padding:8px 12px 12px;flex-wrap:wrap;gap:4px 10px}
.cat.open .cat-body{display:flex}
.item{display:flex;align-items:center;gap:6px;width:calc(50% - 5px);padding:7px 0;font-size:13px;color:#3c4250}
.item input{width:17px;height:17px;accent-color:#0072e3;flex:0 0 auto}
.item em{font-style:normal;font-size:10px;color:#b6bcc9;margin-left:auto}
.item.hide{display:none}
label.f{display:block;margin-bottom:10px}
label.f span{display:block;font-size:12px;color:#8a90a0;margin-bottom:5px}
label.f input,label.f textarea{width:100%;padding:11px 14px;border:1px solid rgba(16,24,40,.08);border-radius:14px;
  font-size:13px;background:#fff;outline:none;font-family:inherit}
label.f textarea{min-height:76px;resize:vertical}
</style>
</head>
<body>
  <h1>性癖大图鉴 · 寻找新XP</h1>
  <div class="sub">勾选偏好 → 点下方「生成提示词」→ 平台自动拼装开局设定</div>

  <div class="searchbar">
    <input id="q" type="text" placeholder="输入关键词搜索（ID、名称、描述）">
    <button type="button" id="doSearch">搜索</button>
  </div>

  <button type="button" class="pill" id="randomBtn">🎲 随机抽12种XP</button>

  <div class="picked">
    <div class="picked-head"><span>已选择偏好</span><span id="count">(0)</span></div>
    <div class="picked-desc">可分配给不同角色，冲突时将在多次回复中生成；数量太高会导致无法生成内容。</div>
    <div class="chips" id="pickedList"><span class="empty">未选择任何XP偏好。</span></div>
  </div>

  <div id="cats">
    <section class="cat">
  <button type="button" class="cat-head" onclick="toggleCat(this)"><span>第一类：世界观</span><i>›</i></button>
  <div class="cat-body">
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A01" data-dsh-label="校园日常"><span>校园日常</span><em>A01</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A02" data-dsh-label="都市夜晚"><span>都市夜晚</span><em>A02</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A03" data-dsh-label="雨夜街道"><span>雨夜街道</span><em>A03</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A04" data-dsh-label="夏日祭典"><span>夏日祭典</span><em>A04</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A05" data-dsh-label="医院病房"><span>医院病房</span><em>A05</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A06" data-dsh-label="图书馆"><span>图书馆</span><em>A06</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A07" data-dsh-label="末班电车"><span>末班电车</span><em>A07</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A08" data-dsh-label="温泉旅馆"><span>温泉旅馆</span><em>A08</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A09" data-dsh-label="无人海岛"><span>无人海岛</span><em>A09</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第一类：世界观" data-dsh-value="A10" data-dsh-label="废土末世"><span>废土末世</span><em>A10</em></label>
  </div>
</section>
    <section class="cat">
  <button type="button" class="cat-head" onclick="toggleCat(this)"><span>第二类：角色</span><i>›</i></button>
  <div class="cat-body">
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B01" data-dsh-label="校花"><span>校花</span><em>B01</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B02" data-dsh-label="学姐"><span>学姐</span><em>B02</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B03" data-dsh-label="邻家妹妹"><span>邻家妹妹</span><em>B03</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B04" data-dsh-label="女教师"><span>女教师</span><em>B04</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B05" data-dsh-label="护士"><span>护士</span><em>B05</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B06" data-dsh-label="女警"><span>女警</span><em>B06</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B07" data-dsh-label="偶像"><span>偶像</span><em>B07</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B08" data-dsh-label="大小姐"><span>大小姐</span><em>B08</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B09" data-dsh-label="双胞胎"><span>双胞胎</span><em>B09</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B10" data-dsh-label="青梅竹马"><span>青梅竹马</span><em>B10</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B11" data-dsh-label="体育老师"><span>体育老师</span><em>B11</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第二类：角色" data-dsh-value="B12" data-dsh-label="班主任"><span>班主任</span><em>B12</em></label>
  </div>
</section>
    <section class="cat">
  <button type="button" class="cat-head" onclick="toggleCat(this)"><span>第三类：恋物</span><i>›</i></button>
  <div class="cat-body">
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C01" data-dsh-label="丝袜"><span>丝袜</span><em>C01</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C02" data-dsh-label="过膝袜"><span>过膝袜</span><em>C02</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C03" data-dsh-label="眼镜"><span>眼镜</span><em>C03</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C04" data-dsh-label="水手服"><span>水手服</span><em>C04</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C05" data-dsh-label="泳装"><span>泳装</span><em>C05</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C06" data-dsh-label="和服"><span>和服</span><em>C06</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C07" data-dsh-label="白大褂"><span>白大褂</span><em>C07</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C08" data-dsh-label="高跟鞋"><span>高跟鞋</span><em>C08</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C09" data-dsh-label="蕾丝内衣"><span>蕾丝内衣</span><em>C09</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C10" data-dsh-label="发带"><span>发带</span><em>C10</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C11" data-dsh-label="手套"><span>手套</span><em>C11</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第三类：恋物" data-dsh-value="C12" data-dsh-label="项圈"><span>项圈</span><em>C12</em></label>
  </div>
</section>
    <section class="cat">
  <button type="button" class="cat-head" onclick="toggleCat(this)"><span>第四类：剧情</span><i>›</i></button>
  <div class="cat-body">
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第四类：剧情" data-dsh-value="D01" data-dsh-label="偷窥"><span>偷窥</span><em>D01</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第四类：剧情" data-dsh-value="D02" data-dsh-label="撞破秘密"><span>撞破秘密</span><em>D02</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第四类：剧情" data-dsh-value="D03" data-dsh-label="深夜补习"><span>深夜补习</span><em>D03</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第四类：剧情" data-dsh-value="D04" data-dsh-label="留校察看"><span>留校察看</span><em>D04</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第四类：剧情" data-dsh-value="D05" data-dsh-label="社团合宿"><span>社团合宿</span><em>D05</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第四类：剧情" data-dsh-value="D06" data-dsh-label="文化祭"><span>文化祭</span><em>D06</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第四类：剧情" data-dsh-value="D07" data-dsh-label="修学旅行"><span>修学旅行</span><em>D07</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第四类：剧情" data-dsh-value="D08" data-dsh-label="家庭访问"><span>家庭访问</span><em>D08</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第四类：剧情" data-dsh-value="D09" data-dsh-label="雨天共伞"><span>雨天共伞</span><em>D09</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第四类：剧情" data-dsh-value="D10" data-dsh-label="天台告白"><span>天台告白</span><em>D10</em></label>
  </div>
</section>
    <section class="cat">
  <button type="button" class="cat-head" onclick="toggleCat(this)"><span>第五类：SM</span><i>›</i></button>
  <div class="cat-body">
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第五类：SM" data-dsh-value="E01" data-dsh-label="束缚"><span>束缚</span><em>E01</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第五类：SM" data-dsh-value="E02" data-dsh-label="眼罩"><span>眼罩</span><em>E02</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第五类：SM" data-dsh-value="E03" data-dsh-label="项圈牵引"><span>项圈牵引</span><em>E03</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第五类：SM" data-dsh-value="E04" data-dsh-label="轻度调教"><span>轻度调教</span><em>E04</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第五类：SM" data-dsh-value="E05" data-dsh-label="命令与服从"><span>命令与服从</span><em>E05</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第五类：SM" data-dsh-value="E06" data-dsh-label="蒙眼猜物"><span>蒙眼猜物</span><em>E06</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第五类：SM" data-dsh-value="E07" data-dsh-label="轻拍"><span>轻拍</span><em>E07</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第五类：SM" data-dsh-value="E08" data-dsh-label="低温蜡"><span>低温蜡</span><em>E08</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第五类：SM" data-dsh-value="E09" data-dsh-label="跪坐等待"><span>跪坐等待</span><em>E09</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第五类：SM" data-dsh-value="E10" data-dsh-label="言语指令"><span>言语指令</span><em>E10</em></label>
  </div>
</section>
    <section class="cat">
  <button type="button" class="cat-head" onclick="toggleCat(this)"><span>第六类：重口</span><i>›</i></button>
  <div class="cat-body">
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第六类：重口" data-dsh-value="F01" data-dsh-label="露出"><span>露出</span><em>F01</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第六类：重口" data-dsh-value="F02" data-dsh-label="公共场合"><span>公共场合</span><em>F02</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第六类：重口" data-dsh-value="F03" data-dsh-label="睡眠中"><span>睡眠中</span><em>F03</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第六类：重口" data-dsh-value="F04" data-dsh-label="失禁"><span>失禁</span><em>F04</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第六类：重口" data-dsh-value="F05" data-dsh-label="体力耗尽"><span>体力耗尽</span><em>F05</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第六类：重口" data-dsh-value="F06" data-dsh-label="强制"><span>强制</span><em>F06</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第六类：重口" data-dsh-value="F07" data-dsh-label="标记"><span>标记</span><em>F07</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第六类：重口" data-dsh-value="F08" data-dsh-label="长时间忍耐"><span>长时间忍耐</span><em>F08</em></label>
  </div>
</section>
    <section class="cat">
  <button type="button" class="cat-head" onclick="toggleCat(this)"><span>第七类：新增未整理</span><i>›</i></button>
  <div class="cat-body">
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第七类：新增未整理" data-dsh-value="G01" data-dsh-label="读心"><span>读心</span><em>G01</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第七类：新增未整理" data-dsh-value="G02" data-dsh-label="意念操控"><span>意念操控</span><em>G02</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第七类：新增未整理" data-dsh-value="G03" data-dsh-label="透视"><span>透视</span><em>G03</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第七类：新增未整理" data-dsh-value="G04" data-dsh-label="时间停止"><span>时间停止</span><em>G04</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第七类：新增未整理" data-dsh-value="G05" data-dsh-label="交换身体"><span>交换身体</span><em>G05</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第七类：新增未整理" data-dsh-value="G06" data-dsh-label="梦境入侵"><span>梦境入侵</span><em>G06</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第七类：新增未整理" data-dsh-value="G07" data-dsh-label="未来视"><span>未来视</span><em>G07</em></label>
      <label class="item"><input type="checkbox" data-dsh-field="xp" data-dsh-type="checkbox" data-dsh-group="第七类：新增未整理" data-dsh-value="G08" data-dsh-label="附身"><span>附身</span><em>G08</em></label>
  </div>
</section>
  </div>

  <h2>主人公设定</h2>
  <label class="f"><span>姓名（留空则随机）</span><input type="text" data-dsh-field="userName" data-dsh-type="text" placeholder="例如：苏小染"></label>
  <label class="f"><span>性别</span><input type="text" data-dsh-field="gender" data-dsh-type="text" value="女"></label>
  <label class="f"><span>性格（留空则随机）</span><input type="text" data-dsh-field="personality" data-dsh-type="text" placeholder="例如：外冷内热、嘴硬心软"></label>
  <label class="f"><span>外貌</span><input type="text" data-dsh-field="appearance" data-dsh-type="text" value="娇小可爱，高颜值美女，身高157cm"></label>
  <label class="f"><span>其他设定</span><textarea data-dsh-field="extra" data-dsh-type="textarea">世界最美之人，男性都仰慕我。基因转变人类，能力：读心、意念操控万物。</textarea></label>

  <h2>世界观</h2>
  <label class="f"><span>世界设定（可修改）</span><textarea data-dsh-field="worldview" data-dsh-type="textarea">现代都市日常，高中校园背景。平凡外表下隐藏着超凡能力的少女。时间、地点、人物关系都贴近现实生活，没有科幻与超自然以外的元素。</textarea></label>

  <h2>前情提要</h2>
  <label class="f"><span>开局情境</span><textarea data-dsh-field="scenario" data-dsh-type="textarea">秋末冬初的午后，市一中教学楼三楼女厕所。你在洗手台前等闺蜜，意外读到了躲在同一间隔间里的体育老师张强的心声。</textarea></label>

<script>
(function(){
  var all = Array.prototype.slice.call(document.querySelectorAll("input[data-dsh-field=xp]"));
  function panel(){
    var picked = all.filter(function(i){ return i.checked; });
    document.getElementById("count").textContent = "(" + picked.length + ")";
    var list = document.getElementById("pickedList");
    if (picked.length === 0) { list.innerHTML = '<span class="empty">未选择任何XP偏好。</span>'; return; }
    list.innerHTML = "";
    picked.forEach(function(input){
      var chip = document.createElement("span");
      chip.className = "chip";
      chip.appendChild(document.createTextNode(input.getAttribute("data-dsh-label")));
      var x = document.createElement("b");
      x.textContent = "\u00d7";
      x.onclick = function(){ input.checked = false; input.dispatchEvent(new Event("change", { bubbles: true })); panel(); };
      chip.appendChild(x);
      list.appendChild(chip);
    });
  }
  all.forEach(function(i){ i.addEventListener("change", panel); });
  window.toggleCat = function(btn){ btn.parentNode.classList.toggle("open"); };
  document.getElementById("randomBtn").onclick = function(){
    all.forEach(function(i){ i.checked = false; });
    var pool = all.slice();
    for (var k = 0; k < 12 && pool.length; k++) {
      var idx = Math.floor(Math.random() * pool.length);
      var pick = pool.splice(idx, 1)[0];
      pick.checked = true;
    }
    all.forEach(function(i){ i.dispatchEvent(new Event("change", { bubbles: true })); });
    panel();
  };
  function search(){
    var q = document.getElementById("q").value.trim().toLowerCase();
    document.querySelectorAll(".item").forEach(function(el){
      var hit = !q || el.textContent.toLowerCase().indexOf(q) >= 0;
      el.classList.toggle("hide", !hit);
      if (q && hit) el.closest(".cat").classList.add("open");
    });
  }
  document.getElementById("doSearch").onclick = search;
  document.getElementById("q").addEventListener("input", search);
  document.querySelectorAll(".cat")[0].classList.add("open");
  panel();
})();
</script>
</body>
</html>`;

export const SEED_CARD_TEMPLATE = String.raw`【初始信息设定】

【全局XP】
{{?xp}}用户选择的偏好：{{f:xp}}{{/xp}}
（若为空则由你根据世界观自行安排）

【世界观】
{{f:worldview}}

【前情提要】
{{f:scenario}}

【主人公设定】
{{?userName}}姓名：{{f:userName}}{{/userName}}
{{?gender}}性别：{{f:gender}}{{/gender}}
{{?personality}}性格：{{f:personality}}{{/personality}}
{{?appearance}}外貌：{{f:appearance}}{{/appearance}}
{{?extra}}其他设定：{{f:extra}}{{/extra}}

请根据以上设定开始叙事，严格按输出格式回复。`;
