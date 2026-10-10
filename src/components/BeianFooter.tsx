// 网站备案号：《非经营性互联网信息服务备案管理办法》第十三条要求在主页底部中央标明备案编号，并链接工信部备案管理系统。每个页面都放。
// 旁边是隐私说明（#/privacy）和不满 14 周岁学生个人信息保护规则（#/privacy?s=minors，现在是隐私说明里的那一节）的链接；手机上放不下就换行
export default function BeianFooter() {
  return (
    <footer className="flex flex-wrap justify-center gap-x-4 gap-y-1 px-4 py-4 text-center text-[12px] text-muted">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="hover:underline">
        沪ICP备2026006107号-2
      </a>
      <a href="#/privacy" className="hover:underline">
        隐私说明
      </a>
      <a href="#/privacy?s=minors" className="hover:underline">
        不满 14 周岁学生个人信息保护规则
      </a>
    </footer>
  )
}
