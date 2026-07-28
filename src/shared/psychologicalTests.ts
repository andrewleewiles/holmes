import type {
  PsychologicalTestDefinition,
  PsychologicalTestExplanation,
  PsychologicalTestId,
  PsychologicalTestOption,
  PsychologicalTestQuestion,
  PsychologicalTestScore,
} from './types'

export const SKIPPED_TEST_ANSWER = -1

const FREQUENCY_OPTIONS: PsychologicalTestOption[] = [
  { value: 0, label: 'Not at all' },
  { value: 1, label: 'Several days' },
  { value: 2, label: 'More than half the days' },
  { value: 3, label: 'Nearly every day' },
]

const ACCURACY_OPTIONS: PsychologicalTestOption[] = [
  { value: 1, label: 'Very Inaccurate' },
  { value: 2, label: 'Moderately Inaccurate' },
  { value: 3, label: 'Neither Inaccurate nor Accurate' },
  { value: 4, label: 'Moderately Accurate' },
  { value: 5, label: 'Very Accurate' },
]

const AGREEMENT_OPTIONS: PsychologicalTestOption[] = [
  { value: 3, label: 'Strongly Agree' },
  { value: 2, label: 'Agree' },
  { value: 1, label: 'Disagree' },
  { value: 0, label: 'Strongly Disagree' },
]

const PSS_OPTIONS: PsychologicalTestOption[] = [
  { value: 0, label: 'Never' },
  { value: 1, label: 'Almost never' },
  { value: 2, label: 'Sometimes' },
  { value: 3, label: 'Fairly often' },
  { value: 4, label: 'Very often' },
]

const WHO_WELLBEING_OPTIONS: PsychologicalTestOption[] = [
  { value: 5, label: 'All of the time' },
  { value: 4, label: 'Most of the time' },
  { value: 3, label: 'More than half of the time' },
  { value: 2, label: 'Less than half of the time' },
  { value: 1, label: 'Some of the time' },
  { value: 0, label: 'At no time' },
]

const YES_NO_OPTIONS: PsychologicalTestOption[] = [
  { value: 0, label: 'No' },
  { value: 1, label: 'Yes' },
]

const ASRS_OPTIONS: PsychologicalTestOption[] = [
  { value: 0, label: 'Never' },
  { value: 1, label: 'Rarely' },
  { value: 2, label: 'Sometimes' },
  { value: 3, label: 'Often' },
  { value: 4, label: 'Very often' },
]

const PHQ_ITEM_IDS = Array.from({ length: 9 }, (_, index) => `phq9-${index + 1}`)

export const PSYCHOLOGICAL_TESTS: PsychologicalTestDefinition[] = [
  {
    id: 'mini_ipip_20',
    name: '20-item Mini-IPIP',
    shortName: 'Mini-IPIP',
    category: 'Personality',
    description: 'A brief measure of five broad personality traits.',
    instructions: 'Select how accurately each statement describes you as you generally are.',
    estimatedMinutes: 4,
    options: ACCURACY_OPTIONS,
    questions: [
      { id: 'mini-ipip-1', prompt: 'Am the life of the party.', domain: 'extraversion' },
      { id: 'mini-ipip-2', prompt: "Sympathize with others' feelings.", domain: 'agreeableness' },
      { id: 'mini-ipip-3', prompt: 'Get chores done right away.', domain: 'conscientiousness' },
      { id: 'mini-ipip-4', prompt: 'Have frequent mood swings.', domain: 'neuroticism' },
      { id: 'mini-ipip-5', prompt: 'Have a vivid imagination.', domain: 'intellect_imagination' },
      { id: 'mini-ipip-6', prompt: "Don't talk a lot.", domain: 'extraversion', reverse: true },
      { id: 'mini-ipip-7', prompt: "Am not interested in other people's problems.", domain: 'agreeableness', reverse: true },
      { id: 'mini-ipip-8', prompt: 'Often forget to put things back in their proper place.', domain: 'conscientiousness', reverse: true },
      { id: 'mini-ipip-9', prompt: 'Am relaxed most of the time.', domain: 'neuroticism', reverse: true },
      { id: 'mini-ipip-10', prompt: 'Am not interested in abstract ideas.', domain: 'intellect_imagination', reverse: true },
      { id: 'mini-ipip-11', prompt: 'Talk to a lot of different people at parties.', domain: 'extraversion' },
      { id: 'mini-ipip-12', prompt: "Feel others' emotions.", domain: 'agreeableness' },
      { id: 'mini-ipip-13', prompt: 'Like order.', domain: 'conscientiousness' },
      { id: 'mini-ipip-14', prompt: 'Get upset easily.', domain: 'neuroticism' },
      { id: 'mini-ipip-15', prompt: 'Have difficulty understanding abstract ideas.', domain: 'intellect_imagination', reverse: true },
      { id: 'mini-ipip-16', prompt: 'Keep in the background.', domain: 'extraversion', reverse: true },
      { id: 'mini-ipip-17', prompt: 'Am not really interested in others.', domain: 'agreeableness', reverse: true },
      { id: 'mini-ipip-18', prompt: 'Make a mess of things.', domain: 'conscientiousness', reverse: true },
      { id: 'mini-ipip-19', prompt: 'Seldom feel blue.', domain: 'neuroticism', reverse: true },
      { id: 'mini-ipip-20', prompt: 'Do not have a good imagination.', domain: 'intellect_imagination', reverse: true },
    ],
    sourceUrl: 'https://ipip.ori.org/MiniIPIPKey.htm',
    attribution: 'Donnellan et al. (2006). Items from the International Personality Item Pool are in the public domain.',
    disclaimer: 'Trait scores are descriptive, not diagnostic. There are no universal Mini-IPIP low, average, or high cutoffs.',
    whatItMeasures: 'Five broad personality traits: Extraversion, Agreeableness, Conscientiousness, Neuroticism, and Intellect / Imagination.',
    limitations: [
      'Raw scores are not compared with a representative population norm.',
      'Personality can vary by setting, role, culture, and current circumstances.',
      'The result does not measure ability, character, or mental illness.',
    ],
    nextSteps: [
      'Compare domains with your own experience rather than treating them as fixed labels.',
      'Use repeated results cautiously because ordinary mood and context can affect responses.',
    ],
    license: { name: 'Public domain', url: 'https://ipip.ori.org/newPermission.htm' },
  },
  {
    id: 'gad_7',
    name: 'Generalized Anxiety Disorder 7-item scale',
    shortName: 'GAD-7',
    category: 'Anxiety screening',
    description: 'A brief screener for the frequency of common anxiety symptoms.',
    instructions: 'Over the last 2 weeks, how often have you been bothered by the following problems?',
    estimatedMinutes: 2,
    options: FREQUENCY_OPTIONS,
    questions: [
      { id: 'gad7-1', prompt: 'Feeling nervous, anxious or on edge' },
      { id: 'gad7-2', prompt: 'Not being able to stop or control worrying' },
      { id: 'gad7-3', prompt: 'Worrying too much about different things' },
      { id: 'gad7-4', prompt: 'Trouble relaxing' },
      { id: 'gad7-5', prompt: 'Being so restless that it is hard to sit still' },
      { id: 'gad7-6', prompt: 'Becoming easily annoyed or irritable' },
      { id: 'gad7-7', prompt: 'Feeling afraid as if something awful might happen' },
    ],
    sourceUrl: 'https://www.phqscreeners.com/select-screener',
    attribution: 'Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
    disclaimer: 'This is a screening result, not a diagnosis. Discuss concerning symptoms with a qualified health professional.',
    whatItMeasures: 'How often seven common anxiety symptoms were experienced during the previous two weeks.',
    limitations: [
      'A score cannot establish generalized anxiety disorder or identify its cause.',
      'Medical conditions, substances, sleep, and acute stress can affect responses.',
      'Clinical interpretation also considers distress, impairment, duration, and history.',
    ],
    nextSteps: [
      'Consider professional follow-up when symptoms are persistent, impairing, or the score is 10 or higher.',
      'Seek support sooner if anxiety feels unmanageable regardless of the total score.',
    ],
    license: { name: 'Public domain', url: 'https://www.phqscreeners.com/select-screener' },
  },
  {
    id: 'phq_9',
    name: 'Patient Health Questionnaire',
    shortName: 'PHQ-9',
    category: 'Depression screening',
    description: 'A brief screener for the frequency and impact of depressive symptoms.',
    instructions: 'Over the last 2 weeks, how often have you been bothered by any of the following problems?',
    estimatedMinutes: 3,
    options: FREQUENCY_OPTIONS,
    questions: [
      { id: 'phq9-1', prompt: 'Little interest or pleasure in doing things' },
      { id: 'phq9-2', prompt: 'Feeling down, depressed, or hopeless' },
      { id: 'phq9-3', prompt: 'Trouble falling or staying asleep, or sleeping too much' },
      { id: 'phq9-4', prompt: 'Feeling tired or having little energy' },
      { id: 'phq9-5', prompt: 'Poor appetite or overeating' },
      { id: 'phq9-6', prompt: 'Feeling bad about yourself - or that you are a failure or have let yourself or your family down' },
      { id: 'phq9-7', prompt: 'Trouble concentrating on things, such as reading the newspaper or watching television' },
      { id: 'phq9-8', prompt: 'Moving or speaking so slowly that other people could have noticed? Or the opposite - being so fidgety or restless that you have been moving around a lot more than usual' },
      { id: 'phq9-9', prompt: 'Thoughts that you would be better off dead or of hurting yourself in some way' },
      {
        id: 'phq9-impact',
        prompt: 'If you checked off any problems, how difficult have these problems made it for you to do your work, take care of things at home, or get along with other people?',
        options: [
          { value: 0, label: 'Not difficult at all' },
          { value: 1, label: 'Somewhat difficult' },
          { value: 2, label: 'Very difficult' },
          { value: 3, label: 'Extremely difficult' },
        ],
        scored: false,
        condition: { kind: 'any-answer', questionIds: PHQ_ITEM_IDS, minimumValue: 1 },
      },
    ],
    sourceUrl: 'https://www.phqscreeners.com/select-screener',
    attribution: 'Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
    disclaimer: 'This is a screening result, not a diagnosis. A clinician must confirm any diagnosis and assess relevant context.',
    whatItMeasures: 'How often nine depressive symptoms were experienced during the previous two weeks, plus their reported functional impact.',
    limitations: [
      'The total does not by itself establish major depressive disorder.',
      'Bereavement, medical conditions, medication, substances, sleep, and other disorders can affect responses.',
      'A zero response to item 9 does not rule out suicide risk when other warning signs are present.',
    ],
    nextSteps: [
      'Consider professional follow-up for persistent symptoms, functional difficulty, or a score of 10 or higher.',
      'Any response above zero on item 9 requires separate safety follow-up regardless of the total score.',
    ],
    contentNotice: 'This assessment includes a question about thoughts of death or self-harm.',
    license: { name: 'Public domain', url: 'https://www.phqscreeners.com/select-screener' },
    safetyNotice: {
      questionId: 'phq9-9',
      minimumValue: 1,
      title: 'Immediate support is available',
      message: "Your response indicates thoughts of death or self-harm. Holmes is not monitored and cannot determine immediate risk. Contact a qualified health professional or crisis service for a safety assessment. If you might act on these thoughts or cannot stay safe, call local emergency services or go to the nearest emergency department. In the U.S. or Canada, call or text 988.",
    },
  },
  {
    id: 'rosenberg_self_esteem',
    name: 'Rosenberg Self-Esteem Scale',
    shortName: 'RSES',
    category: 'Self-esteem',
    description: 'A ten-item measure of global self-esteem.',
    instructions: 'Select the response that best reflects your general feelings about yourself.',
    estimatedMinutes: 3,
    options: AGREEMENT_OPTIONS,
    questions: [
      { id: 'rses-1', prompt: "I feel that I'm a person of worth, at least on an equal plane with others." },
      { id: 'rses-2', prompt: 'I feel that I have a number of good qualities.' },
      { id: 'rses-3', prompt: 'All in all, I am inclined to feel that I am a failure.', reverse: true },
      { id: 'rses-4', prompt: 'I am able to do things as well as most other people.' },
      { id: 'rses-5', prompt: 'I feel I do not have much to be proud of.', reverse: true },
      { id: 'rses-6', prompt: 'I take a positive attitude toward myself.' },
      { id: 'rses-7', prompt: 'On the whole, I am satisfied with myself.' },
      { id: 'rses-8', prompt: 'I wish I could have more respect for myself.', reverse: true },
      { id: 'rses-9', prompt: 'I certainly feel useless at times.', reverse: true },
      { id: 'rses-10', prompt: 'At times I think I am no good at all.', reverse: true },
    ],
    sourceUrl: 'https://socy.umd.edu/about-us/using-rosenberg-self-esteem-scale',
    attribution: 'Rosenberg, M. (1965). Society and the Adolescent Self-Image. The scale is in the public domain.',
    disclaimer: 'This is a dimensional self-report measure, not a diagnosis. No universal clinical cutoffs are used.',
    whatItMeasures: 'A broad sense of personal worth and self-acceptance rather than confidence in a specific skill or role.',
    limitations: [
      'There are no universal clinical low, average, or high cutoffs.',
      'Scores can reflect recent experiences and social context as well as enduring self-view.',
      'The result does not diagnose a mental health condition.',
    ],
    nextSteps: [
      'Use the total as a descriptive baseline and focus on the individual responses that feel most relevant.',
      'Consider support when negative self-evaluation is persistent or causes significant distress.',
    ],
    license: { name: 'Public domain', url: 'https://socy.umd.edu/about-us/using-rosenberg-self-esteem-scale' },
  },
  {
    id: 'who_5',
    name: 'World Health Organization-Five Well-Being Index',
    shortName: 'WHO-5',
    category: 'Wellbeing',
    description: 'A five-item measure of positive mental wellbeing over the last two weeks.',
    instructions: 'Indicate which response is closest to how you have been feeling over the last two weeks. Higher numbers mean better wellbeing.',
    estimatedMinutes: 2,
    options: WHO_WELLBEING_OPTIONS,
    questions: [
      { id: 'who5-1', prompt: 'I have felt cheerful and in good spirits' },
      { id: 'who5-2', prompt: 'I have felt calm and relaxed' },
      { id: 'who5-3', prompt: 'I have felt active and vigorous' },
      { id: 'who5-4', prompt: 'I woke up feeling fresh and rested' },
      { id: 'who5-5', prompt: 'My daily life has been filled with things that interest me' },
    ],
    sourceUrl: 'https://www.who.int/publications/m/item/WHO-UCN-MSD-MHE-2024.01',
    attribution: 'World Health Organization. The World Health Organization-Five Well-Being Index (WHO-5). Geneva: World Health Organization; 2024.',
    disclaimer: 'This is a wellbeing screening measure, not a diagnosis. Lower wellbeing can have many causes and requires context.',
    whatItMeasures: 'Positive mood, calmness, energy, restorative sleep, and interest during the previous two weeks.',
    limitations: [
      'The screening cutoff identifies possible poor wellbeing but does not identify a specific disorder.',
      'Physical illness, sleep disruption, stress, and major life events can affect the score.',
      'A score above the cutoff does not prove that no mental health concern is present.',
    ],
    nextSteps: [
      'Consider further assessment when the raw score is below 13 or the percentage score is below 50.',
      'Track changes over time alongside relevant life, sleep, and health context.',
    ],
    license: { name: 'CC BY-NC-SA 3.0 IGO', url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/igo/' },
  },
  {
    id: 'pss_10',
    name: 'Perceived Stress Scale - 10 Item',
    shortName: 'PSS-10',
    category: 'Stress',
    description: 'A ten-item measure of how unpredictable, uncontrollable, and overloaded life has felt.',
    instructions: 'For each question, indicate how often you felt or thought that way during the last month.',
    estimatedMinutes: 3,
    options: PSS_OPTIONS,
    questions: [
      { id: 'pss10-1', prompt: 'In the last month, how often have you been upset because of something that happened unexpectedly?' },
      { id: 'pss10-2', prompt: 'In the last month, how often have you felt that you were unable to control the important things in your life?' },
      { id: 'pss10-3', prompt: 'In the last month, how often have you felt nervous and "stressed"?' },
      { id: 'pss10-4', prompt: 'In the last month, how often have you felt confident about your ability to handle your personal problems?', reverse: true },
      { id: 'pss10-5', prompt: 'In the last month, how often have you felt that things were going your way?', reverse: true },
      { id: 'pss10-6', prompt: 'In the last month, how often have you found that you could not cope with all the things that you had to do?' },
      { id: 'pss10-7', prompt: 'In the last month, how often have you been able to control irritations in your life?', reverse: true },
      { id: 'pss10-8', prompt: 'In the last month, how often have you felt that you were on top of things?', reverse: true },
      { id: 'pss10-9', prompt: 'In the last month, how often have you been angered because of things that were outside of your control?' },
      { id: 'pss10-10', prompt: 'In the last month, how often have you felt difficulties were piling up so high that you could not overcome them?' },
    ],
    sourceUrl: 'https://www.cmu.edu/dietrich/psychology/stress-immunity-disease-lab/scales/html/pss.html',
    attribution: 'Cohen, S., Kamarck, T., and Mermelstein, R. (1983). A global measure of perceived stress.',
    disclaimer: 'The PSS-10 is dimensional and not diagnostic. Holmes does not apply unofficial low, moderate, or high bands.',
    whatItMeasures: 'The degree to which situations in the previous month were appraised as unpredictable, uncontrollable, and overwhelming.',
    limitations: [
      'There are no universal diagnostic cutoffs for the PSS-10.',
      'Interpretation is strongest when compared with prior scores or an appropriate population norm.',
      'The scale does not identify the source of stress or whether stress is harmful.',
    ],
    nextSteps: [
      'Use the score as a baseline and pair it with notes about major stressors and available support.',
      'Consider professional support if stress is persistent, impairing, or accompanied by other concerning symptoms.',
    ],
    license: { name: 'Noncommercial use with source attribution', url: 'https://www.cmu.edu/dietrich/psychology/stress-immunity-disease-lab/scales/html/pss.html' },
  },
  {
    id: 'pc_ptsd_5',
    name: 'Primary Care PTSD Screen for DSM-5',
    shortName: 'PC-PTSD-5',
    category: 'Trauma screening',
    description: 'A trauma exposure gate followed by five questions about reactions during the past month.',
    instructions: 'The first question asks about lifetime exposure to a traumatic event. Symptom questions appear only when exposure is endorsed.',
    estimatedMinutes: 3,
    options: YES_NO_OPTIONS,
    questions: [
      {
        id: 'pcptsd-exposure',
        prompt: 'Sometimes things happen to people that are unusually or especially frightening, horrible, or traumatic. Examples include a serious accident or fire; physical or sexual assault or abuse; an earthquake or flood; war; seeing someone be killed or seriously injured; or having a loved one die through homicide or suicide. Have you ever experienced this kind of event?',
        scored: false,
      },
      { id: 'pcptsd-1', prompt: 'In the past month, have you had nightmares about the event(s) or thought about the event(s) when you did not want to?', condition: { kind: 'answer', questionId: 'pcptsd-exposure', values: [1] } },
      { id: 'pcptsd-2', prompt: 'In the past month, have you tried hard not to think about the event(s) or gone out of your way to avoid situations that reminded you of the event(s)?', condition: { kind: 'answer', questionId: 'pcptsd-exposure', values: [1] } },
      { id: 'pcptsd-3', prompt: 'In the past month, have you been constantly on guard, watchful, or easily startled?', condition: { kind: 'answer', questionId: 'pcptsd-exposure', values: [1] } },
      { id: 'pcptsd-4', prompt: 'In the past month, have you felt numb or detached from people, activities, or your surroundings?', condition: { kind: 'answer', questionId: 'pcptsd-exposure', values: [1] } },
      { id: 'pcptsd-5', prompt: 'In the past month, have you felt guilty or unable to stop blaming yourself or others for the event(s) or any problems the event(s) may have caused?', condition: { kind: 'answer', questionId: 'pcptsd-exposure', values: [1] } },
    ],
    sourceUrl: 'https://www.ptsd.va.gov/professional/assessment/screens/pc-ptsd.asp',
    attribution: 'Prins et al. (2015). Developed by staff at the U.S. Department of Veterans Affairs National Center for PTSD.',
    disclaimer: 'This screen cannot diagnose PTSD. A positive result should be followed by a fuller assessment with a qualified professional.',
    whatItMeasures: 'Whether trauma exposure is reported and whether five common PTSD-related reactions occurred during the previous month.',
    limitations: [
      'The screen does not establish whether an event meets every clinical trauma criterion.',
      'The commonly used cutoff can perform differently across populations and settings.',
      'A below-cutoff score does not rule out trauma-related difficulties.',
    ],
    nextSteps: [
      'Consider a fuller trauma-informed assessment when the score is 4 or higher or symptoms are distressing.',
      'Pause or exit if answering feels destabilizing and seek support from a trusted or qualified person.',
    ],
    contentNotice: 'This assessment includes examples of trauma and questions about trauma-related reactions. You may exit at any time.',
    license: { name: 'Public domain', url: 'https://www.ptsd.va.gov/professional/assessment/screens/pc-ptsd.asp' },
  },
  {
    id: 'audit_c',
    name: 'Alcohol Use Disorders Identification Test - Consumption',
    shortName: 'AUDIT-C',
    category: 'Alcohol screening',
    description: 'A three-item screen covering alcohol-use frequency, quantity, and heavy-use occasions.',
    instructions: 'Choose the response that best describes your alcohol use.',
    estimatedMinutes: 2,
    options: [],
    questions: [
      {
        id: 'auditc-1',
        prompt: 'How often do you have a drink containing alcohol?',
        options: [
          { value: 0, label: 'Never' },
          { value: 1, label: 'Monthly or less' },
          { value: 2, label: '2 to 4 times a month' },
          { value: 3, label: '2 to 3 times a week' },
          { value: 4, label: '4 or more times a week' },
        ],
      },
      {
        id: 'auditc-2',
        prompt: 'How many drinks containing alcohol do you have on a typical day when you are drinking?',
        options: [
          { value: 0, label: '1 or 2' },
          { value: 1, label: '3 or 4' },
          { value: 2, label: '5 or 6' },
          { value: 3, label: '7 to 9' },
          { value: 4, label: '10 or more' },
        ],
        condition: { kind: 'answer', questionId: 'auditc-1', values: [1, 2, 3, 4] },
      },
      {
        id: 'auditc-3',
        prompt: 'How often do you have six or more drinks on one occasion?',
        options: [
          { value: 0, label: 'Never' },
          { value: 1, label: 'Less than monthly' },
          { value: 2, label: 'Monthly' },
          { value: 3, label: 'Weekly' },
          { value: 4, label: 'Daily or almost daily' },
        ],
        condition: { kind: 'answer', questionId: 'auditc-1', values: [1, 2, 3, 4] },
      },
    ],
    sourceUrl: 'https://www.who.int/publications/i/item/WHO-MSD-MSB-01.6a',
    attribution: 'Adapted from the World Health Organization Alcohol Use Disorders Identification Test (AUDIT), items 1-3.',
    disclaimer: 'This is a screening result, not a diagnosis. Positive-screen cutoffs vary by population, sex, age, and clinical setting.',
    whatItMeasures: 'Three indicators of alcohol exposure and potentially hazardous consumption: frequency, typical quantity, and heavy-use occasions.',
    limitations: [
      'Common positive-screen thresholds range from 3 to 4 depending on population and setting.',
      'The score does not diagnose alcohol use disorder or capture every alcohol-related consequence.',
      'Standard drink sizes vary by country and should be interpreted using local guidance.',
    ],
    nextSteps: [
      'Consider discussing the result with a health professional when it meets a locally appropriate cutoff or alcohol causes concern.',
      'Seek urgent medical advice before abruptly stopping alcohol if physical dependence may be present.',
    ],
    license: { name: 'WHO noncommercial terms', url: 'https://www.who.int/about/policies/publishing/copyright' },
  },
  {
    id: 'asrs_6',
    name: 'Adult ADHD Self-Report Scale v1.1 Screener',
    shortName: 'ASRS-6',
    category: 'Adult ADHD screening',
    description: 'A six-item adult screener for attention, organization, restlessness, and activity symptoms.',
    instructions: 'Choose the response that best describes how you have felt and conducted yourself over the past 6 months.',
    estimatedMinutes: 2,
    options: ASRS_OPTIONS,
    questions: [
      { id: 'asrs6-1', prompt: 'How often do you have trouble wrapping up the final details of a project, once the challenging parts have been done?' },
      { id: 'asrs6-2', prompt: 'How often do you have difficulty getting things in order when you have to do a task that requires organization?' },
      { id: 'asrs6-3', prompt: 'How often do you have problems remembering appointments or obligations?' },
      { id: 'asrs6-4', prompt: 'When you have a task that requires a lot of thought, how often do you avoid or delay getting started?' },
      { id: 'asrs6-5', prompt: 'How often do you fidget or squirm with your hands or feet when you have to sit down for a long time?' },
      { id: 'asrs6-6', prompt: 'How often do you feel overly active and compelled to do things, like you were driven by a motor?' },
    ],
    sourceUrl: 'https://www.hcp.med.harvard.edu/ncs/asrs.php',
    attribution: 'World Health Organization Adult ADHD Self-Report Scale (ASRS) v1.1 Screener. Kessler et al.',
    disclaimer: 'This adult screening result is not an ADHD diagnosis. Diagnosis requires developmental history, impairment, and consideration of other explanations.',
    whatItMeasures: 'Six adult attention, organization, procrastination, restlessness, and overactivity symptoms over the previous six months.',
    limitations: [
      'Sleep, anxiety, depression, trauma, substances, medical conditions, and situational demands can resemble ADHD symptoms.',
      'A diagnosis requires evidence that symptoms began earlier in life and cause impairment in more than one setting.',
      'The screener is intended for adults and is not a child or adolescent assessment.',
    ],
    nextSteps: [
      'Consider a qualified adult ADHD evaluation when four or more keyed responses are endorsed and symptoms cause impairment.',
      'Bring examples from work, home, education, and earlier life to any follow-up assessment.',
    ],
    license: { name: 'WHO noncommercial terms', url: 'https://www.who.int/about/policies/publishing/copyright' },
  },
]

export interface ScoredPsychologicalTest {
  scores: PsychologicalTestScore[]
  summary: string
  explanation: PsychologicalTestExplanation
  safetyFlag: boolean
}

export function getPsychologicalTest(testId: PsychologicalTestId): PsychologicalTestDefinition {
  const test = PSYCHOLOGICAL_TESTS.find((candidate) => candidate.id === testId)
  if (!test) throw new Error('Unknown psychological test')
  return test
}

export function getPsychologicalTestOptions(
  test: PsychologicalTestDefinition,
  question: PsychologicalTestQuestion
): PsychologicalTestOption[] {
  return question.options || test.options
}

export function isPsychologicalTestQuestionVisible(
  test: PsychologicalTestDefinition,
  questionIndex: number,
  answers: number[]
): boolean {
  const condition = test.questions[questionIndex].condition
  if (!condition) return true

  if (condition.kind === 'answer') {
    const dependencyIndex = test.questions.findIndex((question) => question.id === condition.questionId)
    return dependencyIndex >= 0 && condition.values.includes(answers[dependencyIndex])
  }

  return condition.questionIds.some((questionId) => {
    const dependencyIndex = test.questions.findIndex((question) => question.id === questionId)
    return dependencyIndex >= 0 && answers[dependencyIndex] >= condition.minimumValue
  })
}

export function advancePsychologicalTest(
  test: PsychologicalTestDefinition,
  currentIndex: number,
  answers: number[]
): { answers: number[]; nextIndex: number | null } {
  const normalized = [...answers]
  let nextIndex = currentIndex + 1
  while (nextIndex < test.questions.length && !isPsychologicalTestQuestionVisible(test, nextIndex, normalized)) {
    normalized[nextIndex] = SKIPPED_TEST_ANSWER
    nextIndex += 1
  }
  return { answers: normalized, nextIndex: nextIndex < test.questions.length ? nextIndex : null }
}

export function getVisiblePsychologicalTestQuestionIndices(
  test: PsychologicalTestDefinition,
  answers: number[]
): number[] {
  return test.questions
    .map((_, index) => index)
    .filter((index) => isPsychologicalTestQuestionVisible(test, index, answers))
}

function buildExplanation(
  test: PsychologicalTestDefinition,
  headline: string,
  scoreMeaning: string,
  nextSteps: string[] = test.nextSteps
): PsychologicalTestExplanation {
  return {
    headline,
    whatItMeasures: test.whatItMeasures,
    scoreMeaning,
    limitations: test.limitations,
    nextSteps,
  }
}

export function scorePsychologicalTest(
  testId: PsychologicalTestId,
  answers: number[]
): ScoredPsychologicalTest {
  const test = getPsychologicalTest(testId)
  if (answers.length !== test.questions.length) {
    throw new Error(`Expected ${test.questions.length} answers, received ${answers.length}`)
  }

  test.questions.forEach((question, index) => {
    const visible = isPsychologicalTestQuestionVisible(test, index, answers)
    if (!visible) {
      if (answers[index] !== SKIPPED_TEST_ANSWER) throw new Error(`Question ${index + 1} should be skipped`)
      return
    }
    const valid = getPsychologicalTestOptions(test, question).some((option) => option.value === answers[index])
    if (!valid) throw new Error(`Invalid answer for question ${index + 1}`)
  })

  if (testId === 'mini_ipip_20') {
    const domains: Record<string, { label: string; value: number }> = {
      extraversion: { label: 'Extraversion', value: 0 },
      agreeableness: { label: 'Agreeableness', value: 0 },
      conscientiousness: { label: 'Conscientiousness', value: 0 },
      neuroticism: { label: 'Neuroticism', value: 0 },
      intellect_imagination: { label: 'Intellect / Imagination', value: 0 },
    }
    test.questions.forEach((question, index) => {
      if (question.domain) domains[question.domain].value += question.reverse ? 6 - answers[index] : answers[index]
    })
    const scores = Object.entries(domains).map(([key, domain]) => ({
      key,
      label: domain.label,
      value: domain.value,
      maxValue: 20,
      interpretation: `${(domain.value / 4).toFixed(2)} mean on a 1-5 scale`,
    }))
    const summary = 'Higher scores indicate more of each named trait. These raw scores are descriptive and are not compared with population norms.'
    return {
      scores,
      summary,
      explanation: buildExplanation(test, 'A five-domain personality profile', summary),
      safetyFlag: false,
    }
  }

  if (testId === 'gad_7') {
    const total = answers.reduce((sum, answer) => sum + answer, 0)
    const severity = total >= 15 ? 'Severe' : total >= 10 ? 'Moderate' : total >= 5 ? 'Mild' : 'Minimal'
    const summary = `${severity} anxiety symptom range. Scores of 10 or higher commonly warrant further evaluation; this result is not a diagnosis.`
    return {
      scores: [{ key: 'total', label: 'GAD-7 total', value: total, maxValue: 21, interpretation: severity }],
      summary,
      explanation: buildExplanation(test, `${severity} anxiety symptom range`, `The total is ${total} out of 21. Published severity bands place this in the ${severity.toLowerCase()} range. A score of 10 or higher is a common threshold for further evaluation, not proof of a disorder.`),
      safetyFlag: false,
    }
  }

  if (testId === 'phq_9') {
    const total = answers.slice(0, 9).reduce((sum, answer) => sum + answer, 0)
    const severity = total >= 20 ? 'Severe' : total >= 15 ? 'Moderately severe' : total >= 10 ? 'Moderate' : total >= 5 ? 'Mild' : 'None-minimal'
    const safetyQuestionIndex = test.questions.findIndex((question) => question.id === test.safetyNotice?.questionId)
    const safetyFlag = safetyQuestionIndex >= 0 && Boolean(test.safetyNotice && answers[safetyQuestionIndex] >= test.safetyNotice.minimumValue)
    const summary = `${severity} depressive symptom range. This screening result is not a diagnosis.${safetyFlag ? ' The response to item 9 requires independent safety follow-up regardless of the total score.' : ''}`
    return {
      scores: [{ key: 'total', label: 'PHQ-9 total', value: total, maxValue: 27, interpretation: severity }],
      summary,
      explanation: buildExplanation(test, `${severity} depressive symptom range`, `The nine scored items total ${total} out of 27. Published severity bands place this in the ${severity.toLowerCase()} range.${safetyFlag ? ' Item 9 was endorsed, which requires separate safety follow-up even if the total were low.' : ''}`),
      safetyFlag,
    }
  }

  if (testId === 'rosenberg_self_esteem') {
    const total = test.questions.reduce((sum, question, index) => sum + (question.reverse ? 3 - answers[index] : answers[index]), 0)
    const summary = 'Higher totals indicate higher global self-esteem. The score is dimensional and is not assigned a universal low, average, or high category.'
    return {
      scores: [{ key: 'total', label: 'Self-esteem total', value: total, maxValue: 30 }],
      summary,
      explanation: buildExplanation(test, `Self-esteem total: ${total} of 30`, `Higher values reflect greater reported global self-esteem, but the source does not define a universal clinical cutoff. Interpret ${total} as a descriptive raw score or compare it with your own later results.`),
      safetyFlag: false,
    }
  }

  if (testId === 'who_5') {
    const raw = answers.reduce((sum, answer) => sum + answer, 0)
    const percentage = raw * 4
    const belowCutoff = raw < 13
    const interpretation = belowCutoff ? 'Below wellbeing screening cutoff' : 'Screening cutoff not met'
    const summary = belowCutoff
      ? 'The score is below the WHO-5 screening cutoff; further assessment of mental wellbeing may be useful.'
      : 'The score does not meet the WHO-5 poor-wellbeing screening cutoff, but it does not rule out a mental health concern.'
    return {
      scores: [
        { key: 'raw', label: 'WHO-5 raw score', value: raw, maxValue: 25, interpretation },
        { key: 'percentage', label: 'WHO-5 percentage', value: percentage, maxValue: 100 },
      ],
      summary,
      explanation: buildExplanation(test, `${percentage}% wellbeing score`, `The raw score is ${raw} out of 25, equivalent to ${percentage} out of 100. Higher is better. Raw scores below 13, or percentage scores below 50, suggest that further assessment may be useful.`),
      safetyFlag: false,
    }
  }

  if (testId === 'pss_10') {
    const total = test.questions.reduce((sum, question, index) => sum + (question.reverse ? 4 - answers[index] : answers[index]), 0)
    const summary = 'Higher totals indicate greater perceived stress. No universal diagnostic or clinical severity bands are applied.'
    return {
      scores: [{ key: 'total', label: 'PSS-10 total', value: total, maxValue: 40, interpretation: 'Higher means more perceived stress' }],
      summary,
      explanation: buildExplanation(test, `Perceived stress total: ${total} of 40`, `The score is a dimensional measure: higher values indicate that life felt more unpredictable, uncontrollable, or overwhelming. The source does not define universal diagnostic bands, so the most useful comparison is with your own prior scores or an appropriate study population.`),
      safetyFlag: false,
    }
  }

  if (testId === 'pc_ptsd_5') {
    const exposureEndorsed = answers[0] === 1
    const total = exposureEndorsed ? answers.slice(1).reduce((sum, answer) => sum + answer, 0) : 0
    const positive = exposureEndorsed && total >= 4
    const interpretation = !exposureEndorsed ? 'Symptom items not administered' : positive ? 'Positive screen at common cutoff' : 'Below common cutoff'
    const summary = !exposureEndorsed
      ? 'No qualifying trauma exposure was endorsed, so the five symptom questions were not administered.'
      : positive
        ? 'The score meets the commonly used cutoff of 4 for further PTSD assessment. This is not a diagnosis.'
        : 'The score is below the commonly used cutoff of 4, but trauma-related concerns can still warrant support.'
    return {
      scores: [{ key: 'total', label: 'PC-PTSD-5 total', value: total, maxValue: 5, interpretation }],
      summary,
      explanation: buildExplanation(test, interpretation, exposureEndorsed ? `The symptom score is ${total} out of 5. Four is a commonly used screening cutoff, but the best threshold varies with the population and purpose.` : 'Because trauma exposure was not endorsed, the standard administration ends with a score of 0 and does not ask the five symptom questions.'),
      safetyFlag: false,
    }
  }

  if (testId === 'audit_c') {
    const total = answers.reduce((sum, answer) => sum + (answer === SKIPPED_TEST_ANSWER ? 0 : answer), 0)
    const interpretation = total === 0 ? 'No alcohol use reported' : total >= 3 ? 'May meet a common screening cutoff' : 'Below common screening cutoffs'
    const summary = `${interpretation}. AUDIT-C thresholds commonly range from 3 to 4 and should be selected for the relevant population and setting.`
    return {
      scores: [{ key: 'total', label: 'AUDIT-C total', value: total, maxValue: 12, interpretation }],
      summary,
      explanation: buildExplanation(test, interpretation, `The score is ${total} out of 12. Higher scores reflect greater alcohol exposure and risk. Common positive-screen cutoffs range from 3 to 4, so Holmes does not assign a diagnosis or a single universal threshold.`),
      safetyFlag: false,
    }
  }

  const asrsThresholds = [2, 2, 2, 3, 3, 2]
  const keyedResponses = answers.reduce((count, answer, index) => count + (answer >= asrsThresholds[index] ? 1 : 0), 0)
  const positive = keyedResponses >= 4
  const interpretation = positive ? 'Positive adult ADHD screen' : 'Below screening threshold'
  const summary = `${keyedResponses} of 6 responses fall in the keyed range. Four or more is a positive screen that may warrant a full adult ADHD evaluation; it is not a diagnosis.`
  return {
    scores: [{ key: 'keyed', label: 'Keyed responses', value: keyedResponses, maxValue: 6, interpretation }],
    summary,
    explanation: buildExplanation(test, interpretation, `The ASRS screener counts responses that fall within item-specific keyed ranges rather than simply adding frequency values. ${keyedResponses} of 6 responses were keyed; four or more is the published screening threshold.`),
    safetyFlag: false,
  }
}
