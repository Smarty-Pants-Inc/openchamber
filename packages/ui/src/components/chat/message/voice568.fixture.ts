// Records exactly as the smarty-code#568 gateway (dfdc00839) projected a real voice call on the candidate stack
// (session 01a0e258, 2026-09-27; ids and fields as served, text cut to 80 characters, non-text parts omitted).
// Order: two voice exchanges, a typed request, the voice greeting, two more exchanges.
export const voice568Records = [
 {
  "info": {
   "id": "42e4117b",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "user",
   "agent": "build",
   "time": {
    "created": 1790503932381
   },
   "metadata": {
    "smartyVoice": {
     "request": true
    }
   }
  },
  "parts": [
   {
    "id": "part_e9de6ca8ca1af03c3f7f94628c2be93a",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "42e4117b",
    "type": "text",
    "text": "Hi, what is running right now"
   }
  ]
 },
 {
  "info": {
   "id": "ca586652",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "42e4117b",
   "agent": "Voice said",
   "providerID": "smarty-voice",
   "modelID": "voice",
   "finish": "stop",
   "time": {
    "created": 1790503935044,
    "completed": 1790503935044
   },
   "metadata": {
    "smartyVoice": {
     "speaker": "voice"
    }
   }
  },
  "parts": [
   {
    "id": "part_f27d104a5d898a6817698aedfddbbff7",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "ca586652",
    "type": "text",
    "text": "Let me check that."
   }
  ]
 },
 {
  "info": {
   "id": "5050fe10",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "42e4117b",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "tool-calls",
   "time": {
    "created": 1790503932441,
    "completed": 1790503935571
   }
  },
  "parts": []
 },
 {
  "info": {
   "id": "a104a6be",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "42e4117b",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "tool-calls",
   "time": {
    "created": 1790503936172,
    "completed": 1790503938519
   }
  },
  "parts": []
 },
 {
  "info": {
   "id": "cd2b0b98",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "42e4117b",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "stop",
   "time": {
    "created": 1790503938661,
    "completed": 1790503941934
   }
  },
  "parts": [
   {
    "id": "part_60cd64483e17888874ec5557fd15b518",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "cd2b0b98",
    "type": "text",
    "text": "Right now there are no tasks of mine running in the background. On the machine, "
   }
  ]
 },
 {
  "info": {
   "id": "9e7ceac6",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "42e4117b",
   "agent": "Voice said",
   "providerID": "smarty-voice",
   "modelID": "voice",
   "finish": "stop",
   "time": {
    "created": 1790503956853,
    "completed": 1790503956853
   },
   "metadata": {
    "smartyVoice": {
     "speaker": "voice"
    }
   }
  },
  "parts": [
   {
    "id": "part_a1c6dd8fb254fe7d306bc5c31b467774",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "9e7ceac6",
    "type": "text",
    "text": "Right now nothing of mine is running, but the busiest things on the machine are "
   }
  ]
 },
 {
  "info": {
   "id": "f51da19a",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "user",
   "agent": "build",
   "time": {
    "created": 1790503978805
   },
   "metadata": {
    "smartyVoice": {
     "request": true
    }
   }
  },
  "parts": [
   {
    "id": "part_645f91d13857f8d066926628cd6d2c87",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "f51da19a",
    "type": "text",
    "text": "Please check the build status for me"
   }
  ]
 },
 {
  "info": {
   "id": "c9afc9ea",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "f51da19a",
   "agent": "Voice said",
   "providerID": "smarty-voice",
   "modelID": "voice",
   "finish": "stop",
   "time": {
    "created": 1790503981854,
    "completed": 1790503981854
   },
   "metadata": {
    "smartyVoice": {
     "speaker": "voice"
    }
   }
  },
  "parts": [
   {
    "id": "part_e5c9d8c473440386f5c196c7c43dd9dd",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "c9afc9ea",
    "type": "text",
    "text": "Okay, I'll check that."
   }
  ]
 },
 {
  "info": {
   "id": "35b4bf3b",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "f51da19a",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "tool-calls",
   "time": {
    "created": 1790503978820,
    "completed": 1790503982315
   }
  },
  "parts": []
 },
 {
  "info": {
   "id": "2cbea10a",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "f51da19a",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "stop",
   "time": {
    "created": 1790503982402,
    "completed": 1790503985527
   }
  },
  "parts": [
   {
    "id": "part_dcb43b0016c58416a66eeda0baccfff5",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "2cbea10a",
    "type": "text",
    "text": "I couldn't find a build status for this project because there's no build set up "
   }
  ]
 },
 {
  "info": {
   "id": "c9444906",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "f51da19a",
   "agent": "Voice said",
   "providerID": "smarty-voice",
   "modelID": "voice",
   "finish": "stop",
   "time": {
    "created": 1790504000645,
    "completed": 1790504000645
   },
   "metadata": {
    "smartyVoice": {
     "speaker": "voice"
    }
   }
  },
  "parts": [
   {
    "id": "part_d4c7657b725a35f3e47d6e6f7a37a77a",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "c9444906",
    "type": "text",
    "text": "I couldn't find a build status for this project because there's no build set up "
   }
  ]
 },
 {
  "info": {
   "id": "b8dbc003",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "user",
   "agent": "build",
   "time": {
    "created": 1790504182765
   }
  },
  "parts": [
   {
    "id": "part_488ad9bb4258ad89b569b2bc1e12027c",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "b8dbc003",
    "type": "text",
    "text": "List the files in this project folder, then say in one sentence what the project"
   }
  ]
 },
 {
  "info": {
   "id": "ca175e2f",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "b8dbc003",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "tool-calls",
   "time": {
    "created": 1790504182773,
    "completed": 1790504185510
   }
  },
  "parts": []
 },
 {
  "info": {
   "id": "00676bbe",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "b8dbc003",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "tool-calls",
   "time": {
    "created": 1790504185560,
    "completed": 1790504189702
   }
  },
  "parts": []
 },
 {
  "info": {
   "id": "a1b7a191",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "b8dbc003",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "stop",
   "time": {
    "created": 1790504189777,
    "completed": 1790504192223
   }
  },
  "parts": [
   {
    "id": "part_60712c676adab1970d0be168a06c6621",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "a1b7a191",
    "type": "text",
    "text": "The project has one real file, `README.md`. It's 25 bytes and contains only the "
   }
  ]
 },
 {
  "info": {
   "id": "d8f48ef5",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "b8dbc003",
   "agent": "Voice said",
   "providerID": "smarty-voice",
   "modelID": "voice",
   "finish": "stop",
   "time": {
    "created": 1790504234110,
    "completed": 1790504234110
   },
   "metadata": {
    "smartyVoice": {
     "speaker": "voice"
    }
   }
  },
  "parts": [
   {
    "id": "part_936372dfd3024c8010d0b1c91fb6dd70",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "d8f48ef5",
    "type": "text",
    "text": "Hey! When we left off, I found the project only has a README, so it's basically "
   }
  ]
 },
 {
  "info": {
   "id": "24c7392f",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "user",
   "agent": "build",
   "time": {
    "created": 1790504242429
   },
   "metadata": {
    "smartyVoice": {
     "request": true
    }
   }
  },
  "parts": [
   {
    "id": "part_ac61573e226e123403fbd6f784b27955",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "24c7392f",
    "type": "text",
    "text": "Hi, what is running right now"
   }
  ]
 },
 {
  "info": {
   "id": "027c1cf0",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "24c7392f",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "tool-calls",
   "time": {
    "created": 1790504242436,
    "completed": 1790504244773
   }
  },
  "parts": []
 },
 {
  "info": {
   "id": "160a4318",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "24c7392f",
   "agent": "Voice said",
   "providerID": "smarty-voice",
   "modelID": "voice",
   "finish": "stop",
   "time": {
    "created": 1790504245310,
    "completed": 1790504245310
   },
   "metadata": {
    "smartyVoice": {
     "speaker": "voice"
    }
   }
  },
  "parts": [
   {
    "id": "part_ff99de971e2a2bdaa3feab3a520a1097",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "160a4318",
    "type": "text",
    "text": "Let me check that."
   }
  ]
 },
 {
  "info": {
   "id": "e8c62f47",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "24c7392f",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "stop",
   "time": {
    "created": 1790504244855,
    "completed": 1790504247475
   }
  },
  "parts": [
   {
    "id": "part_ed9103933ebd2e643ce21bf86743accd",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "e8c62f47",
    "type": "text",
    "text": "I'm not running anything in the background. On the machine, these are the busies"
   }
  ]
 },
 {
  "info": {
   "id": "7cb5d6e8",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "24c7392f",
   "agent": "Voice said",
   "providerID": "smarty-voice",
   "modelID": "voice",
   "finish": "stop",
   "time": {
    "created": 1790504262510,
    "completed": 1790504262510
   },
   "metadata": {
    "smartyVoice": {
     "speaker": "voice"
    }
   }
  },
  "parts": [
   {
    "id": "part_cb28c4266ce85dccbfc82fa2195358b6",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "7cb5d6e8",
    "type": "text",
    "text": "I'm not running anything in the background. The busiest thing right now is still"
   }
  ]
 },
 {
  "info": {
   "id": "4c427a7a",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "user",
   "agent": "build",
   "time": {
    "created": 1790504289020
   },
   "metadata": {
    "smartyVoice": {
     "request": true
    }
   }
  },
  "parts": [
   {
    "id": "part_ac3d5c42ab1e1515ad52f31857789edd",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "4c427a7a",
    "type": "text",
    "text": "Please check the build status for me"
   }
  ]
 },
 {
  "info": {
   "id": "36dad55e",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "4c427a7a",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "tool-calls",
   "time": {
    "created": 1790504289031,
    "completed": 1790504291868
   }
  },
  "parts": []
 },
 {
  "info": {
   "id": "19c41216",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "4c427a7a",
   "agent": "Voice said",
   "providerID": "smarty-voice",
   "modelID": "voice",
   "finish": "stop",
   "time": {
    "created": 1790504292092,
    "completed": 1790504292092
   },
   "metadata": {
    "smartyVoice": {
     "speaker": "voice"
    }
   }
  },
  "parts": [
   {
    "id": "part_f9438647164b7b694cb46294c87184c1",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "19c41216",
    "type": "text",
    "text": "Okay, checking now."
   }
  ]
 },
 {
  "info": {
   "id": "fe4870ab",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "4c427a7a",
   "agent": "build",
   "providerID": "cliproxyapi-anthropic",
   "modelID": "claude-opus-5-5",
   "finish": "stop",
   "time": {
    "created": 1790504291927,
    "completed": 1790504293976
   }
  },
  "parts": [
   {
    "id": "part_9bad75c796b20367517361e096a7e632",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "fe4870ab",
    "type": "text",
    "text": "There's still no build status to check. Nothing has changed since last time:\n\n- "
   }
  ]
 },
 {
  "info": {
   "id": "2617bb45",
   "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
   "role": "assistant",
   "parentID": "4c427a7a",
   "agent": "Voice said",
   "providerID": "smarty-voice",
   "modelID": "voice",
   "finish": "stop",
   "time": {
    "created": 1790504305304,
    "completed": 1790504305304
   },
   "metadata": {
    "smartyVoice": {
     "speaker": "voice"
    }
   }
  },
  "parts": [
   {
    "id": "part_6bf628565082f12d6ba9630df2e9ab94",
    "sessionID": "01a0e258-99bb-7501-a017-2946138885ee",
    "messageID": "2617bb45",
    "type": "text",
    "text": "There's still no build status to check. Nothing's changed: no CI, and only the R"
   }
  ]
 }
] as const;
