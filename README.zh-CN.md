# 嘉立创 PCB MCP 4.1.0

基于既有 MIL-only 重构，保留一套 17 工具接口。AI 决定布局、路径、铜宽、过孔和分析时机，MCP 封装原生对象、显式几何、批量执行和事实反馈。没有自动布线、设计门控或旧版兼容菜单。

## 编辑与数据

普通编辑使用 pcb_edit，位号、引脚端点、层名和全部几何固定为 mil，未填写字段保留原值。新增 orient 按指定焊盘组朝向目标，copper_path 将明确中心路径转成连续铜带，via_array 生成指定行列、间距、角度的孔阵列。MCP 不寻找绕障路径，不隐式删除旧铜。

pcb_read 的 topology 模式与 pcb_audit_geometry 的 topology 检查共享物理铜模型，返回焊盘连通分量、既有通路、换层、孔径和模型内必经单孔。sections 测量指定截面，excludeIds 只读比较排除对象后的连接。结果不作自动安全删除裁决，也不提供载流等级。

实际成铜、实体铜、凹区和孔洞参与计算，仅有铺铜边界不能形成连接。未知坐标、盲埋孔层跨度、未确认成铜或读取失败明确列入 coverage。曲线离散误差、原生 DRC 和几何建模结果分别说明，不能以 PARTIAL 或 DRC 零错误声称电气验证通过。

## 执行恢复与反馈

可选 requestId 绑定同一请求，同 ID 同内容只返回已存结果，不重复派发；内容不同明确失败。pcb_read 的 receipt/receipts 模式读取持久回执，refresh=true 只读原生日志。boardDelta、wrotePcb、保存结果及各操作状态分开返回，未知写入不重放。这里不承诺原生原子事务或自动回滚。

大结果使用 resultId 分页，MCP 重启后可继续定位保留文件。SVG 支持局部、图层和网络过滤，复合路径保留孔洞，圆弧和旋转边界参与范围计算；编辑仅修改铜区时也能生成局部反馈。图中辅助标识不写入板上丝印。

## 运行与范围

需要 Node.js >=22 和既有本地 Bridge。执行 npm ci --ignore-scripts、npm test、npm run smoke，启动 node src/server.mjs。EASYEDA_PCB_STATE_DIR 可配置回执持久目录，EASYEDA_PCB_ARTIFACT_DIR 可配置结果目录；私有运行数据不得提交仓库。

本次不修改 AgentDock 或 Gateway。自动化使用模拟原生接口和合成几何，真实只读、测试副本写入与生产板设计效果分别验收。完整说明见 [English](README.md)。
