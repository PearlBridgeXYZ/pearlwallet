# 本次修复内容

修复 PearlWallet 在线页面中 PRL 余额无法加载、近期活动一直卡在“正在扫描珍珠+以太”的问题。

## 修复点

- 新增同源接口 `/api/pearl-rpc`，由服务端代理 Pearl JSON-RPC 请求到 Blockbook。
- 默认 PRL RPC 改为 `/api/pearl-rpc`，避免浏览器直接请求外部 RPC 时遇到 CORS 或连接失败。
- 保留原有 Pearl 哨兵 RPC 作为备用节点。
- 查询 PRL 余额和近期活动前，统一规范化 PRL 地址大小写。
- 增加 RPC 请求超时和重试处理，避免页面无限加载。

## 验证

- TypeScript 类型检查通过。
- PRL RPC 测试通过。
- 近期活动扫描测试通过。
- 网络配置测试通过。
- RPC fallback 测试通过。
