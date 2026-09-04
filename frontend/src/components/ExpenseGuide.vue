<script setup>
// 报销整理模块 · 详细使用教程（2026-09-04）
// 纯静态页：覆盖三种身份、建项目→名单→认领→填报→附件→统一支付→项目级区→导出→截止的完整链路 + FAQ
// 内容口径与 backend/routes/expense.js 保持一致；样式全走 CSS 变量（浅色/幽灵模式双主题自适应）
import { useRouter } from 'vue-router';

const router = useRouter();
const back = () => router.push('/expense');

// FAQ 折叠项（原生 <details> 实现，无依赖）
const faqs = [
  {
    q: '邀请链接/邀请码丢了怎么办？',
    a: '找回路径：登录后进「报销整理 → 我的报销项目」，每个项目都能重新复制邀请链接（📋 复制邀请链接按钮）。链接格式 …/expense?code=XXXX，后面 8 位就是邀请码。未登录也能用邀请码直接进：在报销首页「已有邀请链接？」输入框粘贴整条链接或只输 8 位码都能识别。',
  },
  {
    q: '名单里出现同名/重名，认领会乱吗？',
    a: '项目内同名字只允许存在一个（重复添加会提示 409）。如果真有同名同学，请负责人把其中一人改个区分名（如「张乐2」或加队名后缀），认领时按改后的名字点。',
  },
  {
    q: '队员可以帮别人录吗？' ,
    a: '可以，分两种：① 本队互编 —— 认领后能「＋ 添加记录」把出钱人选成同队任何一位队友（代录，卡片归属=队友），也能直接改/删本队任意行的内容（归属与类别冻结不可改，防止把账记错人）；② 跨队 / 项目级代录他人 —— 只有负责人能做。队员的全项目统一支付行只能记自己名下，他人的项目级行只读 —— 帮别的队垫钱或公用开销，请找负责人录。',
  },
  {
    q: '录错了/重复录了怎么删？',
    a: '行卡片右下角有 🗑 删除按钮（谁有权限见上方身份表）：负责人可删任意行；队员可删自己名下与本队行；删除会连同该行已传附件一起清掉，删前有二次确认。误删可让负责人补录一条，删除本身不可恢复。',
  },
  {
    q: '认领后换浏览器/换手机，身份还在吗？',
    a: '认领凭证存在打开页面的浏览器里（localStorage），换设备等于新访客 —— 原来占的名字还在别人手里，新设备无法再认领同一个名字（409）。解决办法：找负责人进「⚙ 管理 → 重置认领」，把旧设备占的名释放后，新设备再点认领即可。',
  },
  {
    q: '认领了别人/想换名字，或要退出填报？',
    a: '页面上有「放弃认领（换名）」按钮：放弃后回到只读访客，名字释放给他人，可再认领任意空名。已认领的状态下直接点另一个空名字 = 自动原子换名（旧名立即释放），不用先放弃。注意：认领过的名字若已被他人占走则不能换到它。',
  },
  {
    q: '成员把名单里的人改名了会怎样？',
    a: '「⚙ 管理」里改名单成员姓名后：该成员名下所有行的归属、耗材的购买人会同步改成新名，Excel/ZIP 导出一致；已认领的旧名字会释放（原 token 身份跟随新名），旧姓名立即不可再认领 —— 建议改名前先提醒本人，改后让 TA 重新点一次新名确认身份。',
  },
  {
    q: '报名截止/填报结束后还要改怎么办？',
    a: '负责人点「🛑 截止填报」后：队员与访客全部只读（看不到任何编辑/上传按钮，服务端同样拦截），但负责人仍可随时改/删/补录做纠错，大家的查看、下载、导出不受影响。纠错完成后可再点「▶ 重新开放」恢复队员填报。',
  },
  {
    q: '附件传错了/要换发票，能替换吗？',
    a: '能。单人记录每个附件槽位同一时间只存一份，重复上传 = 自动替换（旧文件立即删除）；统一支付行/项目级行每个槽位可以放多份（如一批多人发票），逐份管理。传错就重新传一份正确的，或点附件上的删除再传。',
  },
  {
    q: '支持哪些附件？有大小限制吗？',
    a: '发票 PDF、发票查验 PDF、付款凭证/订单/清单截图（png/jpg）、照片都行；单文件上限 25MB，整个项目附件合计软配额 3GB（日常比赛绰绰有余）。PDF 与图片能在网页内直接预览，其余类型可下载；网页源码类（.html 等）一律按附件下载、不会内联打开。空文件会被拒绝。',
  },
  {
    q: 'Excel 和 ZIP 有什么区别，什么时候用哪个？',
    a: 'Excel = 账目汇总：每队一份明细（含「统一支付范围」列写明每笔涵盖的人）+ 全项目统一支付独立区块/独立表，加上全员汇总表（成员 × 六类金额 + 个人合计自动公式）与附件清单页 —— 用于报账核对与留存。ZIP = 按队打包发票原件：文件夹按 01报名费…06零散票据 分好类，里面是该类所有行的发票/凭证原件；另可打包整个项目全部原件（含项目级区）。两者都支持在项目截止后继续导出。',
  },
  {
    q: '这个页面安全吗？谁都能看吗？',
    a: '访问控制的口径是「邀请码即钥匙」：拿到链接的人可以只读查看该项目的全部填报与附件、并认领名单里的空名 —— 请只把链接发给本队/本项目相关的人，不要在公开大群乱发。写入权限按上面身份表分层：每笔行归属服务端强制 = 出钱人本人所选、队员不可冒认他人名字、负责人全程可审计纠错。',
  },
];
</script>

<template>
  <div class="expense-page">
    <div class="exp-wrap guide">
      <div class="card g-head">
        <div class="g-title">
          <el-button size="small" plain @click="back">← 返回报销整理</el-button>
          <h1>🧾 报销整理 · 使用教程</h1>
        </div>
        <p class="g-sub">从「负责人建项目」到「导出 Excel 报账」，一条链路讲完：三种身份怎么分工、六类费用怎么录、
          统一支付与全项目统一支付怎么用、附件怎么传、导出什么格式 —— 文末附常见问题。</p>
      </div>

      <!-- ① 一分钟看懂 -->
      <section class="card g-sec">
        <h2><b>01</b> 一分钟看懂报销整理</h2>
        <div class="flow">
          <div class="f-step"><i>1</i><p>负责人<b>建项目</b>，按比赛实际队伍<b>建队 + 预录成员名单</b></p></div>
          <div class="f-arrow">→</div>
          <div class="f-step"><i>2</i><p><b>复制邀请链接发群</b>，队员打开链接<b>点自己名字认领</b>（免注册登录）</p></div>
          <div class="f-arrow">→</div>
          <div class="f-step"><i>3</i><p>谁花钱谁<b>录一笔</b>：选类别填金额、垫付多人的选「统一支付」，发票凭证<b>拍照/截图传原件</b></p></div>
          <div class="f-arrow">→</div>
          <div class="f-step"><i>4</i><p>随时看<b>统计条</b>；负责人<b>导出 Excel / 按队打包 ZIP</b> 交学校报销</p></div>
        </div>
        <p class="callout info">💡 一句话分工：<b>负责人管结构</b>（建队/名单/截止/导出/纠错），<b>队员管自己的账</b>（认领后互编本队行、自理全项目区自己名下）；不认领只能看，不能写。</p>
      </section>

      <!-- ② 三种身份 -->
      <section class="card g-sec">
        <h2><b>02</b> 三种身份，各自能做什么</h2>
        <p class="g-p">打开报销页面的每一个人都属于下面三种身份之一。页面顶部有身份条实时显示你是哪一种。</p>
        <div class="role-cards">
          <div class="role-card owner">
            <h3><el-tag type="danger" size="small" effect="dark">负责人</el-tag>&nbsp;登录本站账号的管理者</h3>
            <ul>
              <li>建项目 / 建队 / 增删改成员名单 / 重置认领</li>
              <li>录入任意行（任意队伍的成员、公用「队伍」、全项目区任何人）</li>
              <li>改 / 删<b>所有</b>行与附件，截止后仍可纠错</li>
              <li>截止填报 / 重新开放 / 导出 Excel / 打包 ZIP / 删除项目</li>
            </ul>
          </div>
          <div class="role-card member">
            <h3><el-tag type="primary" size="small" effect="dark">队员</el-tag>&nbsp;打开链接点了自己名字认领</h3>
            <ul>
              <li>本队：录入任意成员名下（默认自己，可代录队友）、改/删本队任意行（归属类别冻结）</li>
              <li>全项目统一支付区：<b>只能记自己名下</b>（新增/改/删仅限自己，出钱人自动=本人）</li>
              <li>跨队行 / 他人项目级行：只读</li>
              <li>截止后：全部只读；可「放弃认领」换名</li>
            </ul>
          </div>
          <div class="role-card guest">
            <h3><el-tag type="info" size="small" effect="dark">访客</el-tag>&nbsp;只拿到链接还没认领</h3>
            <ul>
              <li>完整查看所有记录与附件原件（链接 = 钥匙）</li>
              <li>想填报：先点自己的名字认领，变成队员</li>
              <li>名字被占 / 是负责人本人登录名 → 认领按钮不可点</li>
              <li>不能写任何内容（写操作会被服务端 403 拦截）</li>
            </ul>
          </div>
        </div>
        <p class="callout warn">⚠ 登录 ≠ 认领：队员无需登录本站账号，认领凭证存在浏览器里；负责人若是比赛队员，记得在名单里加上自己昵称同名的条目（会自动标记「负责人本人」，该名其他人不可认领）。</p>
      </section>

      <!-- ③ 负责人起步 -->
      <section class="card g-sec">
        <h2><b>03</b> 负责人起步：建项目 → 名单 → 发链接</h2>
        <ol class="g-steps">
          <li><b>登录后</b>进入「报销整理」，右上「＋ 新建项目」：填项目名称（必填，如「电赛省赛报销」）与竞赛名称（选填）。创建后自动带着 8 位邀请码进入填报页。</li>
          <li>在项目页顶部点「＋ 添加队伍」把真实参赛队建出来（如 硬件队 / 软件队）。</li>
          <li>进队伍「⚙ 管理 → ＋ 添加成员」，<b>按真实姓名逐个预录</b>名单 —— 这是后面所有人认领和归属的依据，建议发链接前先录齐。</li>
          <li>点「📋 复制邀请链接」发到微信群。链接形如 <code>https://…/expense?code=XXXX</code> —— 8 位邀请码就是队员的钥匙。</li>
          <li>（可选）把自己也加成队员：名单里加一个与你登录昵称同名的条目即自动生效，方便你作为队员录自己垫的钱。</li>
        </ol>
        <p class="callout tip">💡 好习惯：一个项目 = 一次比赛/一个报销周期。报销结清后可「🛑 截止填报」锁账再导出归档，不必急着删项目；删除项目会连所有记录与附件原件一并清除、不可恢复。</p>
      </section>

      <!-- ④ 队员认领 -->
      <section class="card g-sec">
        <h2><b>04</b> 队员打开链接：认领你的名字</h2>
        <ol class="g-steps">
          <li>点群里链接直接进入项目页（无需注册）；页面顶部「👋 认领你的名字后即可填报」，按队伍分组列出名单。</li>
          <li>找到<b>自己的名字</b>点一下即认领成功，身份条变为绿色「已认领」。之后填的每笔账都会挂在你名下，统计条的「本人合计」实时跟着走。</li>
          <li>重名或找不到自己 → 找负责人改名/重置；误认领了别人的名字 → 点「放弃认领（换名）」释放后重选。</li>
        </ol>
        <p class="callout info">💡 认领即「占名」：同一个名字同时只能被一个浏览器占着。换手机/清缓存后会回到访客，原名字没释放就不能再认 —— 找负责人在 ⚙ 管理里「重置认领」即可。</p>
      </section>

      <!-- ⑤ 六类费用 -->
      <section class="card g-sec">
        <h2><b>05</b> 开始填报：六类费用怎么录</h2>
        <p class="g-p">每张卡右下「＋ 添加记录」→ 弹窗里先选费用类别。一张发票/一笔消费 = 一行；同类别可以有多行（比如来回两张车票各一行）。</p>
        <div class="cat-grid">
          <div class="cat-card"><h3>① 报名费</h3><p>比赛/作品报名交的钱。填 <b>金额</b> + 备注；整队一起交时用「统一支付」写明涵盖的人。</p><p class="att">附件：发票(PDF) / 发票查验(PDF) / 付款凭证(截图)</p></div>
          <div class="cat-card"><h3>② 车票</h3><p>出发/到达<b>日期</b>（日历选，跨天自动隔开）、出发地/到达地、座位等级、金额。往返票分两行录。</p><p class="att">附件：发票(PDF) / 付款凭证(截图)</p></div>
          <div class="cat-card"><h3>③ 住宿</h3><p>酒店名称、房号、入住/退房日期、<b>实付金额</b>。多人同住由一人付时选「统一支付」勾涵盖的人。</p><p class="att">附件：发票(PDF) / 发票查验(PDF) / 住宿清单(图) / 付款凭证(截图)</p></div>
          <div class="cat-card"><h3>④ 邮寄费</h3><p>寄材料/作品的邮费，填金额 + 备注（用途/运单号）。</p><p class="att">附件：发票(PDF) / 发票查验(PDF) / 运单(截图/单号) / 支付凭证(截图)</p></div>
          <div class="cat-card"><h3>⑤ 耗材道具</h3><p>公用买的元器件/道具/材料。<b>购买人</b>必填 —— 写「队伍」= 公用全体分摊（仅负责人可录），写某成员 = 挂他名下；「是否日常/家用物品」选「是」需补「项目使用图」照片证明用于比赛。</p><p class="att">附件：发票(PDF) / 发票查验(PDF) / 订单界面(截图) / 项目使用图(照片)</p></div>
          <div class="cat-card"><h3>⑥ 零散票据</h3><p><b>只在「全项目统一支付」区出现</b>（队伍卡片里不显示）：一张可能含多人/跨队成员的小票/票据合辑（几张打车票、一次代缴）。录「票据名称」+ 金额 + 勾涵盖的人，票据文件本身作为附件传。</p><p class="att">附件：票据/凭证(图或PDF)</p></div>
        </div>
      </section>

      <!-- ⑥ 单人 vs 统一支付 -->
      <section class="card g-sec">
        <h2><b>06</b> 录入方式：单人记录 vs 统一支付（一人为多人垫付）</h2>
        <p class="g-p">选完类别后弹窗底部可切录入方式，<b>类别与录入方式创建后不可改</b>（传错类别就删掉重录）。</p>
        <table class="g-tb">
          <thead><tr><th style="width:130px">方式</th><th>什么时候用</th><th>「涵盖/统一支付范围」怎么填</th></tr></thead>
          <tbody>
            <tr><td><b>单人记录</b></td><td>这笔钱只有一个人出、也只归一个人（默认）</td><td>无需选范围；行归属 = 出钱人</td></tr>
            <tr><td><b>统一支付</b></td><td>一人垫付了<b>多人/全队/整个项目</b>的一笔钱（报名费代缴、全队住宿、集体邮寄…）</td><td>三种选法：<br>· <b>本队全部</b> —— 一键涵盖本队所有名单成员<br>· <b>整个项目全部</b> —— 含所有队伍的全体成员（跨队同项目也能选）<br>· <b>自定义勾选</b> —— 逐人勾，可跨队（只勾实际受益的人）<br>金额 = 这笔<b>合计</b>，统计记在<b>出钱人名下</b>；发票按类别传一份即可</td></tr>
          </tbody>
        </table>
        <p class="callout info">💡 为什么录「统一支付范围」？导出的 Excel 明细每行带范围列，学校财务看到的是「谁为谁垫了多少钱」的完整证据链 —— 别再手写「帮付人」备注了。</p>
      </section>

      <!-- ⑦ 全项目统一支付区 + 标签 -->
      <section class="card g-sec">
        <h2><b>07</b> 全项目统一支付区：项目级账 + 横向队伍标签</h2>
        <p class="g-p">页面主体顶部是一排<b>横向标签</b>：第一个「💰 全项目统一支付」，后面每个队伍一个标签 —— 点哪个标签就查看哪个主体，多队时标签条可横向拖动/滚动（滚动条细条可见；鼠标在标签条上直接滚轮也能横滚，Shift+滚轮更快）。</p>
        <div class="tips-grid">
          <p class="callout info">📌 <b>全项目统一支付区管两类账</b>：① 一人为整个项目（跨队）统一缴纳的费用，如全项目报名费、全团住宿 —— 出钱人可以是任一队的成员或负责人本人，涵盖范围可「整个项目全部 / 勾选跨队子集 / 先不选只存档」；② ⑥ 零散票据（见 §05）。这里的账<b>不属任何队伍</b>，单独统计、Excel 独立成块/独立表、ZIP 归「全项目」包。</p>
          <p class="callout warn">⚠ 队员们注意：全项目统一支付区里，你只能<b>录自己名下</b>的账（弹窗里出钱人固定=你本人，没有下拉框），改/删也只限自己的行；他人的项目级行只读 —— 代他人垫付或公用开销请找负责人录。负责人代录的账若挂你名下，你自己也能编辑纠错。</p>
        </div>
      </section>

      <!-- ⑧ 附件 -->
      <section class="card g-sec">
        <h2><b>08</b> 附件上传：原件进网页，槽位即证据链</h2>
        <ul class="g-ul">
          <li>录入保存后，行卡片下方出现该类别<b>需要的附件槽位</b>（见 §05 各卡片的「附件：」一行），逐个点传即可；缺的槽位随时可补，卡片上直接操作。</li>
          <li>发票建议三件套齐全：<b>发票 PDF + 发票查验 PDF（查验平台导出）+ 付款凭证截图</b>（银行/支付宝/微信支付记录），报销最稳。</li>
          <li>截图/照片在手机上直接拍照上传即可；单文件 ≤25MB；PDF 与图片点开网页内预览，其余下载。</li>
          <li>重传同槽位 = 替换旧文件；统一支付/项目级行一个槽位可放多份（如一批人各一张票）→ 逐份管理、可单独删除。</li>
          <li>删行/删成员会连同其附件一起清除；删项目清空全部 —— 需谨慎，均有二次确认。</li>
        </ul>
      </section>

      <!-- ⑨ 统计与导出 -->
      <section class="card g-sec">
        <h2><b>09</b> 看统计、导出 Excel / ZIP 归档</h2>
        <p class="g-p">头部统计条按六类显示小计与条数、最右为总计 —— 实时汇总<b>全部</b>行（含全项目统一支付区），点队伍标签看到的数字不变。</p>
        <table class="g-tb">
          <thead><tr><th style="width:130px">导出</th><th>内容</th><th>谁可以用</th></tr></thead>
          <tbody>
            <tr><td>📊 导出 Excel</td><td>整个项目一份：<b>汇总</b>（队伍 × 成员两级展开，六类金额列 + 个人合计自动公式）、每队<b>明细</b>（含「统一支付范围」列，写明每笔涵盖的人）、<b>全项目统一支付</b> 独立表（含⑥零散票据）、<b>附件清单</b>页 —— 文件中的 = + - @ 等字符已自动转义防公式注入，可放心发给财务</td><td>负责人</td></tr>
            <tr><td>📦 附件 ZIP（按队）</td><td>该队所有发票/凭证原件，按 01报名费…06零散票据 文件夹分类打包 —— 原件归档直接交</td><td>负责人</td></tr>
            <tr><td>📦 附件 ZIP（全项目）</td><td>全项目统一支付区按钮：全部队伍 + 项目级区原件的大包</td><td>负责人</td></tr>
          </tbody>
        </table>
      </section>

      <!-- ⑩ 截止 -->
      <section class="card g-sec">
        <h2><b>10</b> 截止填报：锁账与纠错</h2>
        <ul class="g-ul">
          <li>报账结清后负责人点「🛑 截止填报」：<b>队员/访客全部只读</b>（编辑/上传按钮消失，服务端同样拦截），查看、下载、导出不受影响；项目标题旁出现「已截止」标。</li>
          <li>截止后发现的错，<b>负责人仍可改/删/补录</b>（纠错通道）；处理完点「▶ 重新开放」恢复队员填报。</li>
          <li>要清场重来？负责人「🗑 删除项目」—— 项目、队伍、成员、全部记录与附件原件一起删除，无法恢复，谨慎。</li>
        </ul>
      </section>

      <!-- FAQ -->
      <section class="card g-sec">
        <h2><b>11</b> 常见问题</h2>
        <div class="faq">
          <details v-for="f in faqs" :key="f.q" class="faq-item">
            <summary>{{ f.q }}</summary>
            <p>{{ f.a }}</p>
          </details>
        </div>
      </section>

      <p class="g-foot">教程覆盖版本：2026-09-04 上线（成员全项目统一支付自理 + 队伍横向标签）。页面有不懂的按钮 → 鼠标悬停通常有提示；还有疑问找负责人。</p>
    </div>
  </div>
</template>

<style scoped>
.expense-page { min-height: 100vh; padding: 18px 14px 40px; }
.exp-wrap { max-width: 980px; margin: 0 auto; }
.card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin-bottom: 14px; }
h1 { font-size: 22px; margin: 0; }
h2 { font-size: 17px; display: flex; align-items: center; gap: 8px; margin: 0 0 12px; }
h2 b { color: var(--primary); font-size: 13px; background: var(--primary-tint); border-radius: 8px; padding: 2px 7px; }
h3 { font-size: 15px; margin: 0 0 8px; }
.g-head { text-align: center; }
.g-title { display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; }
.g-title h1 { display: inline; }
.g-sub { color: var(--text-2); font-size: 13px; line-height: 1.8; margin: 10px auto 0; max-width: 720px; }
.g-p { color: var(--text); line-height: 1.8; font-size: 14px; margin: 4px 0 10px; }

/* 流程四步 */
.flow { display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap; margin: 4px 0 12px; }
.f-step { flex: 1; min-width: 170px; background: var(--surface-2); border-radius: 10px; padding: 10px 12px; }
.f-step i { display: inline-block; width: 20px; height: 20px; line-height: 20px; text-align: center; border-radius: 50%;
  background: var(--primary); color: #fff; font-style: normal; font-size: 12px; font-weight: 700; margin-bottom: 6px; }
.f-step p { margin: 0; font-size: 13px; line-height: 1.7; color: var(--text-2); }
.f-step b { color: var(--text); }
.f-arrow { align-self: center; color: var(--text-2); font-size: 16px; }

/* 角色卡 */
.role-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin-bottom: 10px; }
.role-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.role-card.owner { background: color-mix(in srgb, var(--el-color-danger) 6%, transparent); }
.role-card.member { background: color-mix(in srgb, var(--el-color-primary) 6%, transparent); }
.role-card.guest { background: var(--surface-2); }
.role-card ul { margin: 6px 0 0; padding-left: 18px; }
.role-card li { font-size: 13px; line-height: 1.9; color: var(--text-2); }
.role-card b { color: var(--text); }

/* callout */
.callout { border-radius: 8px; padding: 8px 12px; font-size: 13px; line-height: 1.8; margin: 8px 0; }
.callout.warn { color: #b45309; background: #fef3c7; border: 1px solid #fcd34d; }
.callout.info { color: var(--primary-dark); background: var(--primary-tint); border: 1px solid var(--border); }
.callout.tip { color: #15803d; background: #dcfce7; border: 1px solid #86efac; }
.tips-grid { display: grid; gap: 6px; }

/* 步骤/列表/表格 */
.g-steps { margin: 4px 0 10px; padding-left: 22px; }
.g-steps li { font-size: 14px; line-height: 1.9; margin-bottom: 8px; }
.g-ul { margin: 4px 0 10px; padding-left: 20px; }
.g-ul li { font-size: 14px; line-height: 1.9; margin-bottom: 6px; }
.g-tb { width: 100%; border-collapse: collapse; font-size: 13px; margin: 6px 0 10px; }
.g-tb th, .g-tb td { border: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; line-height: 1.7; }
.g-tb th { background: var(--surface-2); white-space: nowrap; }
.g-tb td b { color: var(--primary-dark); }
.g-tb code { background: var(--surface-2); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
.g-sec code { background: var(--surface-2); padding: 1px 6px; border-radius: 4px; font-size: 12px; }

/* 六类费用卡 */
.cat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 10px; }
.cat-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.cat-card p { margin: 4px 0 0; font-size: 13px; line-height: 1.75; color: var(--text-2); }
.cat-card p.att { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--border); font-size: 12px; color: var(--text-2); }

/* FAQ */
.faq-item { border: 1px solid var(--border); border-radius: 8px; padding: 4px 14px; margin-bottom: 8px; }
.faq-item summary { cursor: pointer; font-size: 14px; font-weight: 600; padding: 8px 0; list-style: none; position: relative; padding-right: 18px; }
.faq-item summary::after { content: '▾'; position: absolute; right: 0; color: var(--text-2); }
.faq-item[open] summary::after { transform: rotate(180deg); }
.faq-item p { font-size: 13px; line-height: 1.9; color: var(--text-2); margin: 0 0 10px; }
.g-foot { text-align: center; color: var(--text-2); font-size: 12px; }

@media (max-width: 768px) {
  .card { padding: 14px; }
  h2 { font-size: 16px; }
  .f-arrow { display: none; }
}
</style>
