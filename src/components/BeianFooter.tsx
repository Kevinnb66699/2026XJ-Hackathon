// 网站备案号：《非经营性互联网信息服务备案管理办法》第十三条要求在主页底部中央标明备案编号，并链接工信部备案管理系统。每个页面都放。
export default function BeianFooter() {
  return (
    <footer className="py-4 text-center text-[12px] text-muted">
      <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="hover:underline">
        沪ICP备2026006107号-2
      </a>
    </footer>
  )
}
