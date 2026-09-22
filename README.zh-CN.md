# EasyEDA PCB MCP 2.4.11

[English](README.md) | 简体中文

该 MCP 通过本机 EasyEDA Pro Bridge 对当前嘉立创 PCB 文档执行类型化、可核验的读写操作。它面向 AgentDock 和其他 MCP 客户端，提供紧凑的生产工具面，并把诊断与兼容工具放在独立配置中，避免模型在大量重复入口之间误选。

2.4.9 将原生详细 DRC 改为有界、可续取作业：原生结果保留在对应 EasyEDA 窗口内，检查较慢时先返回 `RUNNING` 与 `drcJobId`；完成后返回全量违规总数及按类别、规则、对象类型、层等统计，并只分页输出指定违规明细，不再把完整原生树重复传输。无效、失败、丢失或过期的结果会明确保持为未验证。2.4.8 已修复真实客户端中的位号清理适配，并保留必需的 `Designator` 身份属性。

## 主要能力

2.4.11 新增对 EasyEDA Pro 4.1.60 已验证的 0.1 mil 变换后组件焊盘坐标量化的兼容；焊盘号、网络、层和更大的姿态偏差仍严格拒绝。同时保留此前的可续取原生 DRC 与有界分页明细。

- 精确识别当前工程、窗口和 PCB 文档，拒绝过期目标或旧状态断言。
- 读取元件、焊盘、网络、层、约束、图元和关联原理图状态。
- 验证并执行显式 PCB 计划，包括原生圆形或多边形板框、器件移动、走线、过孔、独立 PTH/NPTH、网络端子焊盘和铺铜边界。
- 通过 `pcb_cleanup_components` 预检或执行元件批量解锁与位号丝印显示删除，同时保留元件 Designator 身份并保护接口说明等普通丝印。
- 执行丝印文本计划、铺铜重建、约束组维护、实时 DRC 与可续取完整 DRC、原理图同步、快照、备份和制造文件导出。
- 通过独立读回确认修改结果，部分失败时保留已验证前缀并返回可继续的剩余操作。
- 提供视图截图和基于稳定双读快照的 SVG 检查图，而不依赖修改用户当前视口。

该服务不会自动布局、自动寻路、自动布线、清空整板走线、覆盖整张规则表、执行任意 JavaScript、上传订单或下单。PCB 工程判断由 `easyeda-pcb-layout-routing` 负责。

## 环境与运行

需要 Node.js 22 或更高版本、已授权的本机 EasyEDA Bridge，以及明确选择的 PCB 文档。

```powershell
npm ci
npm test
npm run smoke
npm start
```

SDK 能力注册表测试会自动识别聚合仓库中的 `skills/easyeda-api`、同级克隆的 `easyeda-skill-api` 和旧开发目录。单独放置仓库时，可将 `EASYEDA_API_SKILL_ROOT` 指向 API Skill 根目录，或用 `EASYEDA_API_REFERENCES_ROOT` 直接指定其 `references` 目录。

MCP 使用标准输入输出通信，诊断信息写入标准错误。可通过子进程环境变量 `EASYEDA_ALLOWED_PROJECT_UUIDS` 限制允许访问的工程 UUID 列表。不要把令牌、本机 `.env`、快照、备份或制造输出提交到仓库。

## 分工

| 组件 | 责任 |
| --- | --- |
| 本 MCP | 类型化执行、目标保护、实际读回和工具结果 |
| `easyeda-pcb-layout-routing` | 布局、布线、层叠、电流、回流、丝印和工程验收 |
| `easyeda-api` | 通用 Bridge/Gateway/API 协议与能力说明 |
| 浏览器控制 | MCP 尚未覆盖的原生界面流程和补充观察 |

完整工具表、操作契约、圆形板框、焊盘规范化、局部批次恢复和兼容边界见 [英文详细说明](README.md)。第三方依赖与来源见 [THIRD_PARTY.md](THIRD_PARTY.md)。

