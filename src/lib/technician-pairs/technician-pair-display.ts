import type {
  TechnicianPair,
} from "@/types/technician-pair";

export interface TechnicianPairMember {
  uid: string;
  fullName: string;
}

export type TechnicianPairWithTechnicians =
  TechnicianPair & {
    technicians: [
      TechnicianPairMember,
      TechnicianPairMember,
    ];
  };

export function addTechnicianPairMembers(
  pairs: readonly TechnicianPair[],
  profiles: ReadonlyMap<
    string,
    { fullName?: unknown }
  >
): TechnicianPairWithTechnicians[] {
  return pairs.map((pair) => ({
    ...pair,
    technicians: pair.technicianIds.map(
      (uid) => {
        const profile = profiles.get(uid);
        const fullName = profile?.fullName;

        return {
          uid,
          fullName:
            typeof fullName === "string" &&
            fullName.trim()
              ? fullName.trim()
              : profile
                ? "Unnamed technician"
                : `Technician ${uid}`,
        };
      }
    ) as [
      TechnicianPairMember,
      TechnicianPairMember,
    ],
  }));
}