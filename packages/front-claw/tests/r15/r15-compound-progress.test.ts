/**
 * R16：复合本人进度不是纯标准行，整句交模型路径，离线先问，不出可确认草稿。
 * 训练组与自留组分开统计。自编句子，不取留出集。
 */
import { describe, expect, it } from 'vitest';
import { interpretStandardTail } from '../../src/role-eval/standard-line.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

/** 训练组。 */
export const COMPOUND_TRAIN: { line: string; progress: RegExp }[] = [
  { line: '许姨：720，顺便看我这月到哪了', progress: /到哪了|进度|这月/ },
  { line: '周老师 880，帮我瞅瞅本人完成了几成', progress: /完成|几成/ },
  { line: '钱姐：680（小赵），我排名现在咋样帮忙看下', progress: /排名/ },
  { line: '许姨：500报一下，查查自己累计做了多少', progress: /累计|多少/ },
  { line: '周老师 440，问下我今天完成了没有', progress: /完成|今天/ },
  { line: '许姨：720。我的业绩到哪了呀？', progress: /业绩|到哪了/ },
  { line: '周老师880 查下自己这月完成度', progress: /完成度|这月/ },
  { line: '钱姐：680，麻烦告诉我本月进度如何', progress: /进度/ },
  { line: '许姨：720报一下，想知道我这月多少了', progress: /这月|多少/ },
  { line: '周老师：880，再帮我看哈我本月完成多少', progress: /本月|完成/ },
  { line: '许姨：500，顺便问一下本人业绩怎么样', progress: /业绩/ },
  { line: '钱姐：680，看看我目标还差多少', progress: /目标|差多少/ },
  { line: '许姨 720，帮我查一查我入账到哪了', progress: /入账|到哪了/ },
  { line: '周老师：880（小赵），报一下另外看下我今天进度', progress: /今天|进度/ },
  { line: '许姨：440，同时查一下我自己的完成情况', progress: /完成/ },
  { line: '许姨：720，我本月做了多少你能说下吗', progress: /本月|多少/ },
  { line: '周老师 880，瞅一眼我这月排名呗', progress: /排名/ },
  { line: '钱姐680，问一下我今日入账多少', progress: /入账|今日/ },
  { line: '许姨：500，请帮我看下本人进度呢', progress: /进度/ },
  { line: '许姨：720 顺便告诉我我的进度', progress: /进度/ },
  { line: '周老师880，再跟我说下这月我完成了多少', progress: /完成|这月/ },
  { line: '钱姐：680（小赵）；查查我今天做了多少呀', progress: /今天|多少/ },
  { line: '许姨：440。能告诉我本月业绩吗', progress: /业绩/ },
  { line: '周老师：880，另外帮我问下我完成度', progress: /完成度/ },
  { line: '许姨：720 我进度咋样帮看下', progress: /进度/ },
  { line: '周老师500报一下再看看我累计完成', progress: /累计|完成/ },
  { line: '钱姐：680，我想知道今天进度如何', progress: /进度/ },
  { line: '许姨 720元，看下本人本月到哪了', progress: /本月|到哪了/ },
  { line: '周老师880块，报一声并查下我的业绩', progress: /业绩/ },
  { line: '钱姐：680，可否看一眼我这月几单了', progress: /这月|几单/ },
  { line: '许姨：720（小赵），顺便帮我查下进度到哪了', progress: /进度|到哪了/ },
];

/** 自留组。 */
export const COMPOUND_HELDOUT: { line: string; progress: RegExp }[] = [
  { line: '周老师：760，把我这月完成了多少也告诉我一声', progress: /完成|这月/ },
  { line: '钱姐 900（小赵），我想打听下本人今天业绩', progress: /业绩|今天/ },
  { line: '许姨：610？帮我看一眼自己排名现在怎样', progress: /排名/ },
  { line: '周老师 315，请问我本月进度到哪儿了', progress: /进度/ },
  { line: '许姨720，你能不能说下我累计完成了几成呀', progress: /累计|完成/ },
  { line: '钱姐：545，再劳烦查查我入账情况如何', progress: /入账/ },
  { line: '周老师：990。我这月做了多少方便看下吗', progress: /这月|多少/ },
  { line: '许姨 405，顺口问一句本人目标还差多少呢', progress: /目标|差多少/ },
  { line: '钱姐680块，帮瞅下我今日完成了没', progress: /完成|今日/ },
  { line: '周老师：225（小赵）报一下，我业绩咋样了啊', progress: /业绩/ },
  { line: '许姨：835，也让我知道下这月到哪了', progress: /这月|到哪了/ },
  { line: '钱姐 470，可否告知本人本月进度', progress: /进度/ },
  { line: '周老师880元！我想问下自己完成度呢', progress: /完成度/ },
  { line: '许姨：560，再请帮我列一下我今天入账', progress: /入账|今天/ },
  { line: '钱姐：390，顺便跟我说下我排名啊', progress: /排名/ },
  { line: '周老师 640，查一查看我本月多少了哈', progress: /本月|多少/ },
  { line: '许姨：715。能帮看看自己的业绩到哪了不', progress: /业绩|到哪了/ },
  { line: '钱姐 820（小赵），问声我累计做了多少可以吗', progress: /累计|多少/ },
  { line: '周老师：355，我这月几单了麻烦看下', progress: /这月|几单/ },
  { line: '许姨 275，告诉我一声本人今天进度好不好', progress: /进度|今天/ },
  { line: '钱姐：910，再问问我目标完成怎样了', progress: /目标|完成/ },
  { line: '周老师 185，帮我问下我入账到哪了谢谢', progress: /入账/ },
  { line: '许姨：625，顺带瞅瞅本人这月完成了没', progress: /完成|这月/ },
  { line: '钱姐：455。我想知道下我的排名怎样', progress: /排名/ },
  { line: '周老师 790，请告诉我今天完成了多少吧', progress: /今天|完成/ },
  { line: '许姨：330（小赵），另外想看下我本月业绩', progress: /业绩|本月/ },
  { line: '钱姐 510，能不能查下自己进度呀？', progress: /进度/ },
  { line: '周老师：860，报完也看看我累计入账多少', progress: /累计|入账/ },
  { line: '许姨 705，我完成度如何请看一下', progress: /完成度/ },
  { line: '钱姐：240，再帮我看下这月我到哪了呢', progress: /这月|到哪了/ },
  { line: '周老师 670，顺便让我晓得本人今天几单了', progress: /今天|几单/ },
];

describe('R16 复合进度·不是纯标准行（解析层可有残片或复合）', () => {
  it('「不错但没做」仍是 D130 备注，不误当成进度', () => {
    const t = interpretStandardTail('不错但没做');
    expect(t.remark).toMatch(/不错但没做/);
  });
});

async function assertAskNoDraft(lines: { line: string }[], label: string) {
  const w = await worldM05();
  const failed: string[] = [];
  for (const { line } of lines) {
    const before = (await w.base.listDrafts({ status: 'pending' })).length;
    const r = await w.call('m-zhao', line);
    const after = await w.base.listDrafts({ status: 'pending' });
    const drafted = /还没入账/.test(r) || after.length > before;
    const asked = /没有写入任何账目|行尾备注|请.*再|说不清|没看清|没太明白/.test(r);
    if (drafted || !asked) {
      failed.push(`${label} 「${line}」 drafted=${drafted} asked=${asked} reply=${r.slice(0, 240)}`);
    }
    for (const d of after) {
      if (d.status === 'pending') await w.call('m-zhao', '取消');
    }
  }
  expect(failed, failed.join('\n')).toEqual([]);
}

describe('R16 复合进度·员工入口一律先问、不出草稿', () => {
  it(`训练组 ${COMPOUND_TRAIN.length} 条先问、无可确认草稿`, async () => {
    expect(COMPOUND_TRAIN.length).toBeGreaterThanOrEqual(30);
    await assertAskNoDraft(COMPOUND_TRAIN, 'train');
  });

  it(`自留组 ${COMPOUND_HELDOUT.length} 条先问、无可确认草稿`, async () => {
    expect(COMPOUND_HELDOUT.length).toBeGreaterThanOrEqual(30);
    await assertAskNoDraft(COMPOUND_HELDOUT, 'held');
  });

  it('「周姐560，顺便算下这周还差几单」标准行加残片，整句先问、不出草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '周姐560，顺便算下这周还差几单');
    expect(r).not.toContain('还没入账');
    expect(r).toMatch(/没有写入任何账目|行尾备注|说不清|没太明白/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });
});
