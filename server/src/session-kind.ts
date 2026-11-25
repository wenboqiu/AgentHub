// 内部会话：AgentHub 自己开给电脑端 agent 用的会话——角色助手（一句话造角色）、意见细化（写任务单）。
//
// 这类会话的首条用户消息是 AgentHub 写的契约提示词（CONTRACT / REFINE_CONTRACT / TICKET_CONTRACT），
// 不是人说的话。所以标题只能由服务端定，规矩有三条：
//   ① 建会话时给「角色助手：/ 意见细化：」前缀的名字；
//   ② 本机 transcript 里读到的标题（首条用户消息截断）不许覆盖它，否则标题会退化成一大段提示词原文
//      （见 db.ts 的 applyEvent 与 renamePendingSession）；
//   ③ 界面上单独收进「内部会话」分组，不跟真人的活混在待处理 / 进行中里。
export const ASSISTANT_TITLE = '角色助手：'
export const PROPOSAL_TITLE = '意见细化：'

const PREFIXES = [ASSISTANT_TITLE, PROPOSAL_TITLE]

/** 这个标题是不是服务端给内部会话起的名字（界面侧同一套前缀见 src/lib/internal.ts） */
export const isInternalTitle = (title: string) => PREFIXES.some((p) => title.startsWith(p))

/** 契约提示词的首行：历史数据里被顶掉标题的老会话靠它认出来，修回友好名 */
export const CONTRACT_HEADS = ['你在 AgentHub 里当项目经理', '你在 AgentHub 里当「角色顾问」']

/** 迁移回填用：内部会话标题的 LIKE 模式——含被契约提示词顶掉的历史标题（migrateProposals 先修回友好名） */
export const INTERNAL_TITLE_LIKES = [...PREFIXES, ...CONTRACT_HEADS].map((p) => `${p}%`)
