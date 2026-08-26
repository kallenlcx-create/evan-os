import fs from 'node:fs'

let c = fs.readFileSync('src/pages/Knowledge.tsx', 'utf8').split(/\r?\n/)

// 替换 530-578 行（case inspiration..decision 的旧实现）
const newBlock = `      case 'inspiration':
      case 'question':
      case 'research':
      case 'experiment':
      case 'decision': {
        const typeMap: Record<string, { items: any[]; label: string; emoji: string; type: ObjectType }> = {
          inspiration: { items: inspirations, label: '灵感', emoji: '💡', type: 'inspiration' },
          question: { items: questions, label: '问题', emoji: '❓', type: 'question' },
          research: { items: research, label: '研究', emoji: '🔬', type: 'research' },
          experiment: { items: experiments, label: '实验', emoji: '🧪', type: 'experiment' },
          decision: { items: decisions, label: '决策', emoji: '🧩', type: 'decision' },
        }
        const info = typeMap[activeTab]

        // 合并：markType 匹配的 knowledge 条目 + 对应表记录
        const markedK = knowledge.filter(k => (k as any).markType === activeTab)
        const tableItems: any[] = info.items.map(item => ({
          ...item, _source: 'table', _type: info.type,
        }))
        const markedItems: any[] = markedK.map(k => ({
          id: k.id, title: k.title, _source: 'knowledge', _type: 'knowledge',
          content: k.content, createdAt: k.createdAt,
        }))
        const allItems = [...markedItems, ...tableItems]

        const handleEditItem = async (item: any) => {
          const title = prompt('修改标题', item.title ?? ''); if (title === null || !title.trim()) return
          if (item._source === 'knowledge') {
            await updateObject('knowledge', item.id, { title: title.trim() })
          } else {
            await updateObject(item._type, item.id, { title: title.trim() })
          }
        }

        return (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                placeholder={\`添加\${info.label}...\`}
                className="flex-1 px-4 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-blue-400"
                onKeyDown={e => e.key === 'Enter' && handleAddSimple(info.type)}
              />
              <button
                onClick={() => handleAddSimple(info.type)}
                className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium"
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="space-y-2">
              {allItems.length === 0 && (
                <div className="text-center py-8 text-gray-400 text-sm">暂无{info.label}</div>
              )}
              {allItems.map(item => (
                <div key={item.id} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 flex items-center justify-between group">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="text-lg">{info.emoji}</span>
                    <span className="text-sm font-medium text-gray-700 truncate">{item.title}</span>
                    {item._source === 'knowledge' && (
                      <button onClick={() => setViewingId(item.id)} className="text-[10px] text-blue-400 hover:text-blue-600 shrink-0" title="查看详情">
                        📄
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button onClick={() => handleEditItem(item)} className="p-1 text-gray-300 hover:text-blue-500" title="编辑">
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => {
                        const src = item._source === 'knowledge' ? 'knowledge' : item._type
                        deleteObject(src, item.id)
                      }}
                      className="p-1 text-gray-300 hover:text-red-500"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      }`

// 找到旧块范围（case 'inspiration' 到其闭合 '}'）
const start = c.findIndex(l => l.trim() === "case 'inspiration':")
const end = c.findIndex((l, i) => i > start && l.trim() === '}' && c[i + 1]?.trim() === '')

c.splice(start, end - start + 1, newBlock)
fs.writeFileSync('src/pages/Knowledge.tsx', c.join('\n'))
console.log('replaced, new block lines:', newBlock.split('\n').length)
