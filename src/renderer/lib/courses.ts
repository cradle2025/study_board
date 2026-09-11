import type { TimetableData } from '@shared/types'

/**
 * 从课表里抽出「有哪些课」。
 *
 * 需求原文：「如果前面的课程表是以表格方式填写则课程名称和授课老师
 * 直接从表格中自动拷贝填写」——所以新建卡片时要能从这里挑，
 * 而不是让用户把课程名和老师再手打一遍（打错一个字，卡片和课表就对不上了）。
 *
 * 同一门课在课表里可能出现多次（周一三五各一节），这里按
 * 「课程名 + 老师」去重，保留第一次出现的顺序。
 */

export interface CourseRef {
  courseName: string
  teacher: string
}

export function distinctCourses(data: TimetableData | null): CourseRef[] {
  if (!data) return []

  const seen = new Set<string>()
  const out: CourseRef[] = []

  // cells 的 key 是 "节次:列号"，按节次排序能让下拉里的顺序跟课表看起来一致
  const keys = Object.keys(data.cells).sort((a, b) => {
    const [aPeriod = 0, aCol = 0] = a.split(':').map(Number)
    const [bPeriod = 0, bCol = 0] = b.split(':').map(Number)
    return aPeriod - bPeriod || aCol - bCol
  })

  for (const key of keys) {
    const cell = data.cells[key]
    if (!cell) continue
    const courseName = cell.courseName.trim()
    if (courseName.length === 0) continue

    const teacher = cell.teacher.trim()
    const signature = `${courseName}\u0000${teacher}`
    if (seen.has(signature)) continue
    seen.add(signature)
    out.push({ courseName, teacher })
  }

  return out
}
